// app/routes/api.inventory.apply-change.tsx
// Phase1: 在庫変更＋履歴を1本化。イベントを先にDB保存→Shopify実行→履歴記録

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";
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
  const key = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) key[i] = secret.charCodeAt(i);
  return key;
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
  return `gid://stock-transfer-pos/InventoryCount/${id}`;
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
      } catch (err) {
        throw err;
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

    const entriesParsed: ApplyChangeEntry[] = entriesRaw
      .filter(
        (e: any) =>
          e?.inventoryItemId &&
          (Number.isFinite(Number(e?.quantityAfter)) || Number.isFinite(Number(e?.delta)))
      )
      .map((e: any) => ({
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

    let sessions = await (sessionStorage as any).findSessionsByShop(shop);
    let session = sessions?.find((s: any) => s.isOnline === false) ?? sessions?.[0];
    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "No offline session for shop" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    await refreshOfflineSessionIfNeeded(session.id, session.shop, session.expires, session.refreshToken ?? null);
    const sessionsAfter = await (sessionStorage as any).findSessionsByShop(shop);
    session = sessionsAfter?.find((s: any) => s.isOnline === false) ?? sessionsAfter?.[0];
    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "Session not found after refresh" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const requestedAt = new Date();
    const shopDomain = session.shop;
    const accessToken = session.accessToken;

    const admin = {
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

    // delta のみのエントリは現在値を取得して quantityAfter に正規化（ロス・仕入用）
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

    const lineRecords: { id: string; inventoryItemId: string; quantityAfter: number; delta: number | null; quantityBefore: number | null; variantId: string | null; sku: string }[] = [];

    for (const e of entries) {
      const delta = e.delta ?? (e.quantityBefore != null ? e.quantityAfter - e.quantityBefore : null);
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
        quantityAfter: e.quantityAfter,
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
    let result = await setInventoryQuantitiesServer(admin, locationId, shopifyItems, refUri);
    if (!result.ok && isTransientError(result.error)) {
      await new Promise((r) => setTimeout(r, 1500));
      const retryResult = await setInventoryQuantitiesServer(admin, locationId, shopifyItems, refUri);
      if (retryResult.ok) result = retryResult;
    }

    const rawLocId = toRawId(locationId);
    const resolvedLocationName = locationName || rawLocId || locationId;
    const dateUtc = getDateInShopTimezone(requestedAt, "UTC");

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
            date: dateUtc,
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
            note: null,
          },
          update: {
            delta: l.delta,
            quantityAfter: l.quantityAfter,
            locationName: resolvedLocationName,
            sourceId,
            note: null,
          },
        });
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
    for (const l of lineRecords) {
      await db.inventoryChangeEventLine.update({
        where: { id: l.id },
        data: { lineStatus: "failed", errorMessage: errorSummary },
      });
    }
    await db.inventoryChangeEvent.update({
      where: { id: event.id },
      data: { status: "failed", errorSummary },
    });

    return new Response(
      JSON.stringify({
        ok: false,
        error: errorSummary,
        eventId: event.id,
        appEventId,
        status: "failed",
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (e: any) {
    console.error("[api.inventory.apply-change] Error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}
