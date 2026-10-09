// app/routes/api.inventory.apply-change.tsx
// Phase1: 在庫変更＋履歴を1本化。イベントを先にDB保存→Shopify実行→履歴記録

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import db from "../db.server";
import type { SessionStorageWithFindByShop } from "../types";
import { getDateInShopTimezone, getShopTimezone } from "../utils/timezone";
import { refreshOfflineSessionIfNeeded } from "../utils/refresh-offline-session";
import {
  setInventoryQuantitiesServer,
  fetchCurrentQuantityServer,
} from "../utils/inventory-set-quantities-server";
import { ensureInventoryActivatedAtLocation } from "../utils/ensure-inventory-activated-server";

/** 一時的な障害とみなしてリトライするか（429/5xx/ネットワーク系） */
function isTransientError(errorSummary: string | undefined): boolean {
  if (!errorSummary) return false;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("429") ||
    s.includes("503") ||
    s.includes("500") ||
    s.includes("502") ||
    s.includes("504") ||
    s.includes("timeout") ||
    s.includes("fetch") ||
    s.includes("network")
  );
}

/** Shopify changeFromQuantity CAS 不一致（同時売上/返品等） */
function isChangeFromQuantityStale(errorSummary: string | undefined): boolean {
  if (!errorSummary) return false;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("changefromquantity") ||
    s.includes("change_from_quantity") ||
    s.includes("change from quantity")
  );
}

/** 棚卸・調整の絶対値 set: activate 後スナップショット CAS（D9 follow-up） */
function usesPostActivateCas(activity: string): boolean {
  return activity === "inventory_count" || activity === "adjustment";
}

const API_VERSION = "2026-01";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function shopFromDest(dest: string): string {
  try {
    const u = new URL(dest.startsWith("http") ? dest : `https://${dest}`);
    return u.hostname;
  } catch {
    return dest;
  }
}

function secretToKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function decodePOSToken(token: string): Promise<{ dest?: string } | null> {
  const apiSecretKey = process.env.SHOPIFY_API_SECRET || "";
  if (!apiSecretKey) return null;
  try {
    const key = secretToKey(apiSecretKey);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], clockTolerance: 10 });
    return payload as { dest?: string };
  } catch {
    return null;
  }
}

function toRawId(id: string | number | null | undefined): string {
  if (id == null) return "";
  const s = String(id).trim();
  if (s.startsWith("gid://")) return s.split("/").pop() || s;
  return s;
}

function referenceDocumentUriForActivity(activity: string, refId: string | null): string | undefined {
  if (!refId) return undefined;
  const id = refId.startsWith("gid://") ? refId.split("/").pop() : refId;
  if (activity === "loss_entry") return `gid://stock-transfer-pos/LossEntry/${id}`;
  if (activity === "purchase_entry" || activity === "purchase_cancel") return `gid://stock-transfer-pos/PurchaseEntry/${id}`;
  if (activity === "adjustment") return `gid://stock-transfer-pos/AdjustmentEntry/${id}`;
  if (activity === "inbound_transfer") return `gid://stock-transfer-pos/InboundTransfer/${id}`;
  if (activity === "outbound_transfer") return `gid://stock-transfer-pos/OutboundTransfer/${id}`;
  return `gid://stock-transfer-pos/InventoryCount/${id}`;
}

/** POS に返す例外メッセージ。Response / 非 Error を "Unknown error" に潰さない */
function formatCaughtError(e: unknown): string {
  if (e instanceof Error) {
    const msg = (e.message || e.name || "").trim();
    return msg || "Error";
  }
  if (typeof Response !== "undefined" && e instanceof Response) {
    return `HTTP ${e.status}${e.statusText ? ` ${e.statusText}` : ""}`.trim();
  }
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e && typeof e === "object") {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    try {
      const s = JSON.stringify(e);
      if (s && s !== "{}") return s.slice(0, 300);
    } catch {
      /* ignore */
    }
  }
  if (e == null) return "Unknown error";
  const s = String(e).trim();
  return s || "Unknown error";
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

type ApplyChangeEntry = {
  inventoryItemId: string;
  variantId?: string | null;
  sku?: string | null;
  quantityAfter: number | null;
  quantityBefore?: number | null;
  delta?: number | null;
};

export async function action({ request }: ActionFunctionArgs) {
  // outer catch 用: イベント作成後に例外が飛んだとき failed 化・先行履歴掃除に使う
  let createdEventId: string | null = null;
  let cleanupShop: string | null = null;
  let cleanupAppEventId: string | null = null;
  let cleanupIdempotencyKeys: string[] = [];

  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ ok: false, error: "Missing session token" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    let sessionToken: { dest?: string } | null = await decodePOSToken(token);
    if (!sessionToken?.dest) {
      try {
        const auth = await authenticate.pos(request);
        sessionToken = auth.sessionToken;
      } catch (err: unknown) {
        const is401 =
          (err as { status?: number })?.status === 401 ||
          (typeof Response !== "undefined" && err instanceof Response && err.status === 401);
        const errMsg = formatCaughtError(err);
        console.warn(
          "[api.inventory.apply-change] POS auth failed:",
          is401 ? "Invalid session token" : errMsg
        );
        return new Response(
          JSON.stringify({
            ok: false,
            error: is401 ? "Invalid session token" : errMsg,
          }),
          {
            status: is401 ? 401 : 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          }
        );
      }
    }
    const dest = sessionToken?.dest;
    if (!dest) {
      return new Response(JSON.stringify({ ok: false, error: "No shop in session token" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    const shop = shopFromDest(dest);

    const body = await request.json().catch(() => ({}));
    const appEventId = typeof body.appEventId === "string" ? body.appEventId.trim() : null;
    const activity = typeof body.activity === "string" ? body.activity.trim() : "";
    const locationId = typeof body.locationId === "string" ? body.locationId.trim() : "";
    const locationName = typeof body.locationName === "string" ? body.locationName.trim() : "";
    const sourceId = body.sourceId != null ? String(body.sourceId).trim() : null;
    const referenceDocumentUri = body.referenceDocumentUri != null ? String(body.referenceDocumentUri).trim() : null;
    const entriesRaw = Array.isArray(body.entries) ? body.entries : [];

    if (!appEventId || !activity || !locationId) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing appEventId, activity, or locationId" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    type RawEntry = { inventoryItemId?: unknown; variantId?: unknown; sku?: unknown; quantityAfter?: unknown; quantityBefore?: unknown; delta?: unknown };
    const entriesParsed: ApplyChangeEntry[] = (entriesRaw as RawEntry[])
      .filter(
        (e) =>
          e?.inventoryItemId &&
          (Number.isFinite(Number(e?.quantityAfter)) || Number.isFinite(Number(e?.delta)))
      )
      .map((e) => ({
        inventoryItemId: String(e.inventoryItemId).trim(),
        variantId: e.variantId != null ? String(e.variantId) : null,
        sku: e.sku != null ? String(e.sku) : "",
        quantityAfter: e.quantityAfter != null ? Math.floor(Number(e.quantityAfter)) : null,
        quantityBefore: e.quantityBefore != null ? Math.floor(Number(e.quantityBefore)) : null,
        delta: e.delta != null ? Math.floor(Number(e.delta)) : null,
      }));

    if (entriesParsed.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "No valid entries" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const storage = sessionStorage as SessionStorageWithFindByShop;
    let sessions = await storage.findSessionsByShop(shop);
    let session = sessions?.find((s) => s.isOnline === false) ?? sessions?.[0];
    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "No offline session for shop" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const expiresDate =
      session.expires != null
        ? (session.expires instanceof Date ? session.expires : new Date(session.expires))
        : null;
    await refreshOfflineSessionIfNeeded(session.id, session.shop, expiresDate, session.refreshToken ?? null);
    const sessionsAfter = await storage.findSessionsByShop(shop);
    session = sessionsAfter?.find((s) => s.isOnline === false) ?? sessionsAfter?.[0];
    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "Session not found after refresh" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const requestedAt = new Date();
    const shopDomain = session.shop;
    const accessToken = session.accessToken;

    let admin = {
      graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        return fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({
            query: query.replace(/^#graphql\s*/m, "").trim(),
            variables: opts?.variables ?? {},
          }),
        });
      },
    };
    admin = withGraphQLRetry(admin);

    // 冪等性チェック: 同一 appEventId が既に存在する場合は既存結果を返す（POS リトライ対策）
    // ★ delta→quantityAfter 正規化（Shopify API 呼び出しを伴う）より前に実行することで、
    //   リトライ時の不要な API 呼び出しとレートリミット消費を防ぐ。
    const existingEvent = await db.inventoryChangeEvent.findUnique({
      where: { appEventId },
      include: { lines: true },
    }).catch(() => null);
    if (existingEvent) {
      if (existingEvent.status === "completed") {
        return new Response(
          JSON.stringify({
            ok: true,
            eventId: existingEvent.id,
            appEventId,
            status: "completed",
            appliedCount: existingEvent.lines.length,
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
      const isProcessing = existingEvent.status === "pending" || existingEvent.status === "applying";
      if (isProcessing) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: existingEvent.errorSummary || "Event already exists with status: " + existingEvent.status,
            eventId: existingEvent.id,
            appEventId,
            status: existingEvent.status,
          }),
          { status: 202, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
      // partial_failed: 在庫が一部変わっている可能性があるため自動再実行しない
      if (existingEvent.status === "partial_failed") {
        return new Response(
          JSON.stringify({
            ok: false,
            error:
              existingEvent.errorSummary ||
              "Event already exists with status: partial_failed（一部適用済み。手動確認が必要です）",
            eventId: existingEvent.id,
            appEventId,
            status: existingEvent.status,
            partiallyApplied: true,
          }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
      // failed: 安定 appEventId での再確定を許可するため、失敗イベントを削除して続行
      // （以前は errorSummary「Unknown error」等が sticky になり、棚卸確定が永久に失敗していた）
      if (existingEvent.status === "failed") {
        console.warn(
          `[api.inventory.apply-change] clearing failed event for retry: appEventId=${appEventId} prevError=${existingEvent.errorSummary ?? "(none)"}`
        );
        try {
          await db.inventoryChangeEventLine.deleteMany({ where: { eventId: existingEvent.id } });
          await db.inventoryChangeEvent.delete({ where: { id: existingEvent.id } });
          await db.inventoryChangeLog.deleteMany({
            where: {
              shop,
              quantityAfter: null,
              idempotencyKey: { startsWith: `${shop}_app_${appEventId}_` },
            },
          });
        } catch (clearErr: unknown) {
          console.warn(
            "[api.inventory.apply-change] failed-event cleanup error:",
            formatCaughtError(clearErr)
          );
          return new Response(
            JSON.stringify({
              ok: false,
              error:
                existingEvent.errorSummary ||
                "Event already exists with status: failed（再試行用のクリアに失敗しました）",
              eventId: existingEvent.id,
              appEventId,
              status: existingEvent.status,
            }),
            { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
          );
        }
        // fall through: 新規イベント作成へ
      } else {
        return new Response(
          JSON.stringify({
            ok: false,
            error: existingEvent.errorSummary || "Event already exists with status: " + existingEvent.status,
            eventId: existingEvent.id,
            appEventId,
            status: existingEvent.status,
          }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
    }

    // delta のみのエントリは現在値を取得して quantityAfter に正規化（ロス・仕入用）
    // 冪等性チェック通過後にのみ実行することで、リトライ時の無駄な API 呼び出しを防ぐ。
    const entries: ApplyChangeEntry[] = [];
    for (const e of entriesParsed) {
      let qtyAfter = e.quantityAfter;
      let qtyBefore = e.quantityBefore ?? null;
      if (qtyAfter == null && e.delta != null) {
        const cur = await fetchCurrentQuantityServer(admin, locationId, e.inventoryItemId);
        qtyBefore = cur;
        qtyAfter = cur + e.delta;
      }
      if (qtyAfter == null) continue;
      entries.push({
        ...e,
        quantityAfter: qtyAfter,
        quantityBefore: qtyBefore ?? undefined,
      });
    }
    if (entries.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "No valid entries after normalization" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const event = await db.inventoryChangeEvent.create({
      data: {
        appEventId,
        shop,
        activity,
        locationId,
        locationName: locationName || null,
        sourceType: activity,
        sourceId,
        requestedAt,
        status: "pending",
      },
    });
    createdEventId = event.id;
    cleanupShop = shop;
    cleanupAppEventId = appEventId;

    const lineRecords: { id: string; inventoryItemId: string; quantityAfter: number; delta: number | null; quantityBefore: number | null; variantId: string | null; sku: string }[] = [];

    for (const e of entries) {
      // e.quantityAfter はこのループに入る前に null チェック済み（null の場合は continue で除外）
      const qAfter = e.quantityAfter as number;
      const delta = e.delta ?? (e.quantityBefore != null ? qAfter - e.quantityBefore : null);
      const line = await db.inventoryChangeEventLine.create({
        data: {
          eventId: event.id,
          inventoryItemId: e.inventoryItemId,
          variantId: e.variantId ?? null,
          sku: e.sku ?? null,
          delta,
          quantityBefore: e.quantityBefore ?? null,
          quantityAfterExpected: e.quantityAfter,
          quantityAfterActual: null,
          lineStatus: "pending",
        },
      });
      lineRecords.push({
        id: line.id,
        inventoryItemId: e.inventoryItemId,
        quantityAfter: qAfter,
        delta,
        quantityBefore: e.quantityBefore ?? null,
        variantId: e.variantId ?? null,
        sku: e.sku ?? "",
      });
    }

    await db.inventoryChangeEvent.update({
      where: { id: event.id },
      data: { status: "applying" },
    });

    const rawLocIdEarly = toRawId(locationId);
    const resolvedLocationNameEarly = locationName || rawLocIdEarly || locationId;
    const shopTimezoneEarly = await getShopTimezone(admin).catch(() => "UTC");
    const shopDateEarly = getDateInShopTimezone(requestedAt, shopTimezoneEarly);
    const idempotencyKeyBaseEarly = `${shop}_app_${appEventId}`;
    cleanupIdempotencyKeys = lineRecords.map(
      (l) => `${idempotencyKeyBaseEarly}_${toRawId(l.inventoryItemId)}_${rawLocIdEarly}`
    );

    // R-HIST / Phase F: setQuantities 前に InventoryChangeLog を先行書き込み（quantityAfter=null）。
    // webhook が同一 appEventId 軸の業務行を見つけて early-return できるようにし、admin_webhook 二重行を減らす。
    for (const l of lineRecords) {
      const rawItemId = toRawId(l.inventoryItemId);
      const idempotencyKey = `${idempotencyKeyBaseEarly}_${rawItemId}_${rawLocIdEarly}`;
      try {
        await db.inventoryChangeLog.upsert({
          where: { shop_idempotencyKey: { shop, idempotencyKey } },
          create: {
            shop,
            timestamp: requestedAt,
            date: shopDateEarly,
            inventoryItemId: rawItemId,
            variantId: l.variantId,
            sku: l.sku,
            locationId: rawLocIdEarly,
            locationName: resolvedLocationNameEarly,
            activity,
            delta: l.delta,
            quantityAfter: null,
            sourceType: activity,
            sourceId,
            idempotencyKey,
            note: `appEventId:${appEventId}`,
          },
          update: {
            delta: l.delta,
            activity,
            sourceType: activity,
            sourceId,
            note: `appEventId:${appEventId}`,
          },
        });
      } catch (e: unknown) {
        console.warn(
          "[api.inventory.apply-change] pre-setQuantities history upsert failed:",
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    const shopifyItems = lineRecords.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantityAfter }));
    // 在庫レベルがないアイテムを先に有効化（調整・棚卸で「not stocked at the location」エラーを防ぐ）
    let activateResult = await ensureInventoryActivatedAtLocation(admin, locationId, shopifyItems);
    const maxActivateRetries = 2;
    for (let r = 0; r < maxActivateRetries && (activateResult.errors?.length ?? 0) > 0; r++) {
      const failedGids = new Set(activateResult.errors?.map((e) => e.inventoryItemId) ?? []);
      const toItemGid = (id: string) =>
        /^\d+$/.test(String(id).trim()) ? `gid://shopify/InventoryItem/${String(id).trim()}` : String(id).trim();
      const failedItems = shopifyItems.filter((q) => failedGids.has(toItemGid(q.inventoryItemId)));
      if (failedItems.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (r + 1)));
      activateResult = await ensureInventoryActivatedAtLocation(admin, locationId, failedItems);
    }
    if ((activateResult.errors?.length ?? 0) > 0) {
      const errSummary = activateResult.errors?.map((e) => e.message).join(" / ") ?? "在庫有効化に失敗しました";
      for (const l of lineRecords) {
        await db.inventoryChangeEventLine.update({
          where: { id: l.id },
          data: { lineStatus: "failed", errorMessage: errSummary },
        });
      }
      await db.inventoryChangeEvent.update({
        where: { id: event.id },
        data: { status: "failed", errorSummary: errSummary },
      });
      // 先行履歴が webhook に latch されないよう、未確定（quantityAfter null）行を削除
      try {
        await db.inventoryChangeLog.deleteMany({
          where: {
            shop,
            idempotencyKey: {
              in: lineRecords.map(
                (l) => `${idempotencyKeyBaseEarly}_${toRawId(l.inventoryItemId)}_${rawLocIdEarly}`
              ),
            },
            quantityAfter: null,
          },
        });
      } catch (e: unknown) {
        console.warn(
          "[api.inventory.apply-change] cleanup pre-write logs (activate fail):",
          e instanceof Error ? e.message : String(e)
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: errSummary,
          eventId: event.id,
          appEventId,
          status: "failed",
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const refUri = referenceDocumentUriForActivity(activity, referenceDocumentUri);
    // 棚卸・調整: activate 後に live available を読んで CAS（#13 の null オプトアウトを補完。
    // activate 前読取での CAS は D9 どおり不整合のため使わない）。
    const casOpts = usesPostActivateCas(activity) ? { casFromLiveSnapshot: true } : undefined;
    let result = await setInventoryQuantitiesServer(admin, locationId, shopifyItems, refUri, casOpts);
    // partial_failed（一部適用＋ロールバック失敗）は同一リクエスト内でも再 set しない
    if (
      !result.ok &&
      !result.partiallyApplied &&
      casOpts &&
      isChangeFromQuantityStale(result.error)
    ) {
      // 再読取スナップショットで 1 回だけ再試行（同時売上の短いレース）
      await new Promise((r) => setTimeout(r, 400));
      const staleRetry = await setInventoryQuantitiesServer(admin, locationId, shopifyItems, refUri, casOpts);
      if (staleRetry.ok) {
        result = staleRetry;
      } else if (isChangeFromQuantityStale(staleRetry.error)) {
        result = {
          ...staleRetry,
          error:
            "確定処理中に在庫数が変更されました（売上・返品など）。" +
            "画面を再読み込みし、在庫数を確認してから再度確定してください。",
        };
      } else {
        result = staleRetry;
      }
    } else if (!result.ok && !result.partiallyApplied && isTransientError(result.error)) {
      await new Promise((r) => setTimeout(r, 1500));
      const retryResult = await setInventoryQuantitiesServer(admin, locationId, shopifyItems, refUri, casOpts);
      if (retryResult.ok) result = retryResult;
    }

    const rawLocId = toRawId(locationId);
    const resolvedLocationName = locationName || rawLocId || locationId;
    // ショップのタイムゾーンで日付を計算（UTC固定だと日本など非UTCショップで日付がずれる）
    const shopTimezone = await getShopTimezone(admin).catch(() => "UTC");
    const shopDate = getDateInShopTimezone(requestedAt, shopTimezone);

    if (result.ok) {
      for (const l of lineRecords) {
        await db.inventoryChangeEventLine.update({
          where: { id: l.id },
          data: { lineStatus: "applied", quantityAfterActual: l.quantityAfter, appliedAt: new Date() },
        });
      }
      await db.inventoryChangeEvent.update({
        where: { id: event.id },
        data: { status: "completed", errorSummary: result.invalidCount ? `invalidCount: ${result.invalidCount}` : null },
      });

      const idempotencyKeyBase = `${shop}_app_${appEventId}`;
      for (const l of lineRecords) {
        const rawItemId = toRawId(l.inventoryItemId);
        const idempotencyKey = `${idempotencyKeyBase}_${rawItemId}_${rawLocId}`;
        await db.inventoryChangeLog.upsert({
          where: { shop_idempotencyKey: { shop, idempotencyKey } },
          create: {
            shop,
            timestamp: requestedAt,
            date: shopDate,
            inventoryItemId: rawItemId,
            variantId: l.variantId,
            sku: l.sku,
            locationId: rawLocId,
            locationName: resolvedLocationName,
            activity,
            delta: l.delta,
            quantityAfter: l.quantityAfter,
            sourceType: activity,
            sourceId,
            idempotencyKey,
            note: `appEventId:${appEventId}`,
          },
          update: {
            delta: l.delta,
            quantityAfter: l.quantityAfter,
            locationName: resolvedLocationName,
            sourceId,
            note: `appEventId:${appEventId}`,
          },
        });

        // R-HIST: 同一物理変動の admin_webhook 行を業務 activity に上書き（二重行防止）。
        // 売上/返品救済を壊さないため、quantityAfter が null または今回値と一致する行のみ、短い窓で合流。
        try {
          const itemCands = [rawItemId, `gid://shopify/InventoryItem/${rawItemId}`];
          const locCands = [rawLocId, `gid://shopify/Location/${rawLocId}`];
          const searchFrom = new Date(requestedAt.getTime() - 10 * 60 * 1000);
          const searchTo = new Date(requestedAt.getTime() + 2 * 60 * 1000);
          const recentAdmin = await db.inventoryChangeLog.findFirst({
            where: {
              shop,
              inventoryItemId: { in: itemCands },
              locationId: { in: locCands },
              activity: "admin_webhook",
              timestamp: { gte: searchFrom, lte: searchTo },
              NOT: { idempotencyKey },
              OR: [{ quantityAfter: null }, { quantityAfter: l.quantityAfter }],
            },
            orderBy: { timestamp: "desc" },
          });
          if (recentAdmin) {
            await db.inventoryChangeLog.update({
              where: { id: recentAdmin.id },
              data: {
                activity,
                sourceType: activity,
                sourceId,
                delta: l.delta,
                quantityAfter: l.quantityAfter,
                locationName: resolvedLocationName,
                note: `coalesced_from_admin_webhook;appEventId:${appEventId}`,
              },
            });
          }
        } catch (e: unknown) {
          console.warn(
            "[api.inventory.apply-change] admin_webhook coalesce skipped:",
            e instanceof Error ? e.message : String(e)
          );
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          eventId: event.id,
          appEventId,
          status: "completed",
          appliedCount: lineRecords.length,
          invalidCount: result.invalidCount,
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const errorSummary = result.error || "Shopify API error";
    // partiallyApplied: チャンク分割時にロールバック失敗→一部の在庫が変更済みの状態
    const finalStatus = result.partiallyApplied ? "partial_failed" : "failed";
    for (const l of lineRecords) {
      await db.inventoryChangeEventLine.update({
        where: { id: l.id },
        data: { lineStatus: "failed", errorMessage: errorSummary },
      });
    }
    await db.inventoryChangeEvent.update({
      where: { id: event.id },
      data: { status: finalStatus, errorSummary },
    });

    // 完全失敗時のみ先行履歴を削除（partial_failed は在庫が一部変わっている可能性があるため残す）
    if (!result.partiallyApplied) {
      try {
        await db.inventoryChangeLog.deleteMany({
          where: {
            shop,
            idempotencyKey: {
              in: lineRecords.map(
                (l) => `${idempotencyKeyBaseEarly}_${toRawId(l.inventoryItemId)}_${rawLocIdEarly}`
              ),
            },
            quantityAfter: null,
          },
        });
      } catch (e: unknown) {
        console.warn(
          "[api.inventory.apply-change] cleanup pre-write logs (setQuantities fail):",
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: errorSummary,
        eventId: event.id,
        appEventId,
        status: finalStatus,
        partiallyApplied: result.partiallyApplied ?? false,
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (e: unknown) {
    console.error("[api.inventory.apply-change] Error:", e);
    const message = formatCaughtError(e);

    // イベント作成後の未処理例外: applying/pending のまま残すと安定 appEventId 再送が 202 で固まる
    if (createdEventId) {
      try {
        await db.inventoryChangeEventLine.updateMany({
          where: { eventId: createdEventId },
          data: { lineStatus: "failed", errorMessage: message },
        });
        await db.inventoryChangeEvent.update({
          where: { id: createdEventId },
          data: { status: "failed", errorSummary: message },
        });
      } catch (markErr: unknown) {
        console.warn(
          "[api.inventory.apply-change] mark failed after outer catch:",
          formatCaughtError(markErr)
        );
      }
      if (cleanupShop && cleanupIdempotencyKeys.length > 0) {
        try {
          await db.inventoryChangeLog.deleteMany({
            where: {
              shop: cleanupShop,
              idempotencyKey: { in: cleanupIdempotencyKeys },
              quantityAfter: null,
            },
          });
        } catch (cleanupErr: unknown) {
          console.warn(
            "[api.inventory.apply-change] cleanup pre-write logs (outer catch):",
            formatCaughtError(cleanupErr)
          );
        }
      } else if (cleanupShop && cleanupAppEventId) {
        try {
          await db.inventoryChangeLog.deleteMany({
            where: {
              shop: cleanupShop,
              quantityAfter: null,
              idempotencyKey: { startsWith: `${cleanupShop}_app_${cleanupAppEventId}_` },
            },
          });
        } catch (cleanupErr: unknown) {
          console.warn(
            "[api.inventory.apply-change] cleanup pre-write logs by prefix (outer catch):",
            formatCaughtError(cleanupErr)
          );
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: message,
        ...(createdEventId ? { eventId: createdEventId, status: "failed" } : {}),
        ...(cleanupAppEventId ? { appEventId: cleanupAppEventId } : {}),
      }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}
