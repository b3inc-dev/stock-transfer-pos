// app/routes/api.pos-stocktake-complete.tsx
// POS 棚卸確定完了報告を受け、メタフィールドをサーバー側で 1 回 read → 更新 → 1 回 write する API
// STOCKTAKE_COMPLETE_RETRY_DESIGN: バックアップ・自動リトライ・needMetafieldRetry

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import type { SessionStorageWithFindByShop } from "../types";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { refreshOfflineSessionIfNeeded } from "../utils/refresh-offline-session";
import {
  normalizeIdForMatch,
} from "./app.inventory-count";
import { upsertInventoryCountDocument } from "../utils/inventory-count-document.server";
import {
  writePendingCompleteBackup,
  readPendingCompleteBackup,
  applyPendingCompleteFromBackup,
  type PendingCompleteBackup,
  type PendingCompleteGroup,
} from "../utils/stocktake-pending-complete.server";

const API_VERSION = "2026-01";
/** POS client Abort は 120s。サーバ自動リトライ合計がそれを超えないよう間隔を抑える */
const META_RETRY_MAX = 3;
const META_RETRY_DELAY_MS = 1500;

function shopFromDest(dest: string): string {
  try {
    const u = new URL(dest);
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
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      clockTolerance: 10,
    });
    return payload as { dest?: string };
  } catch (e: unknown) {
    console.warn("[api.pos-stocktake-complete] decodeSessionToken error:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: object, status: number, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function isChunkCorruptionError(msg: string): boolean {
  return /棚卸チャンク\d+が存在しません|チャンク.*欠落|chunk.*missing/i.test(msg);
}

function isTransientMetaError(msg: string): boolean {
  if (isChunkCorruptionError(msg)) return false;
  const s = msg.toLowerCase();
  return (
    s.includes("429") ||
    s.includes("503") ||
    s.includes("502") ||
    s.includes("504") ||
    s.includes("throttle") ||
    s.includes("timeout") ||
    s.includes("network") ||
    s.includes("fetch") ||
    s.includes("syntax error") ||
    s.includes("unexpected end")
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type CompletedGroup = PendingCompleteGroup;

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    console.log("[api.pos-stocktake-complete] CORS preflight (OPTIONS) received");
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  const origin = request.headers.get("origin") ?? "(no origin)";
  console.warn("STOCKTAKE_API_ORIGIN [server] request received: method=" + request.method + " origin=" + origin);
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const authHeader = request.headers.get("authorization");
  const hasAuth = authHeader?.startsWith("Bearer ");
  if (!hasAuth) {
    console.warn("STOCKTAKE_API_ORIGIN [server] response 401: Missing session token");
    return jsonResponse({ ok: false, error: "Missing session token" }, 401);
  }
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();

  let sessionToken: { dest?: string } | null = await decodePOSToken(token);
  if (!sessionToken?.dest) {
    try {
      const auth = await authenticate.pos(request);
      sessionToken = auth.sessionToken as { dest?: string } | null;
    } catch (err) {
      console.warn("[api.pos-stocktake-complete] POS auth failed:", err instanceof Error ? err.message : String(err));
      console.warn("STOCKTAKE_API_ORIGIN [server] response 401: Invalid session token (decode or authenticate.pos failed)");
      return jsonResponse({ ok: false, error: "Invalid session token" }, 401);
    }
  }
  const dest = sessionToken?.dest;
  if (!dest || typeof dest !== "string") {
    console.warn("STOCKTAKE_API_ORIGIN [server] response 401: No shop in session token");
    return jsonResponse({ ok: false, error: "No shop in session token" }, 401);
  }
  const shop = shopFromDest(dest);

  const storage = sessionStorage as SessionStorageWithFindByShop;
  const sessions = await storage.findSessionsByShop(shop);
  let session = sessions?.find((s) => s.isOnline === false) ?? sessions?.[0];
  if (session) {
    const expiresDate =
      session.expires != null
        ? new Date(typeof session.expires === "number" ? session.expires : (session.expires as Date).getTime())
        : null;
    await refreshOfflineSessionIfNeeded(session.id, session.shop, expiresDate, session.refreshToken ?? null);
    const sessionsAfter = await storage.findSessionsByShop(shop);
    session = sessionsAfter?.find((s) => s.isOnline === false) ?? sessionsAfter?.[0];
  }
  if (!session?.accessToken) {
    console.warn("STOCKTAKE_API_ORIGIN [server] response 401: Shop session not found (shop=" + shop + ")");
    return jsonResponse({ ok: false, error: "Shop session not found" }, 401);
  }

  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  let admin: AdminGraphql = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      return fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: query.replace(/^#graphql\s*/m, "").trim(),
          variables: opts?.variables ?? {},
        }),
      });
    },
  };
  admin = withGraphQLRetry(admin);

  let ownerId: string;
  try {
    const appInstResp = await admin.graphql(
      `#graphql query GetAppInstallation { currentAppInstallation { id } }`
    );
    const appInstJson = (await appInstResp.json().catch(() => ({}))) as { data?: { currentAppInstallation?: { id?: string } }; errors?: Array<{ message?: string }> };
    if (appInstJson?.errors?.length) {
      console.warn("[api.pos-stocktake-complete] GraphQL errors:", appInstJson.errors);
      return jsonResponse({ ok: false, error: "currentAppInstallation の取得に失敗しました" }, 500);
    }
    ownerId = appInstJson?.data?.currentAppInstallation?.id ?? "";
  } catch (e) {
    console.warn("[api.pos-stocktake-complete] get ownerId failed:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ ok: false, error: "currentAppInstallation.id が取得できませんでした" }, 500);
  }
  if (!ownerId) {
    return jsonResponse({ ok: false, error: "currentAppInstallation.id が取得できませんでした" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Request body must be JSON" }, 400);
  }

  const retryOnly =
    typeof body === "object" && body !== null && "retryOnly" in body && Boolean((body as { retryOnly?: unknown }).retryOnly);

  let countId =
    typeof body === "object" && body !== null && "countId" in body && typeof (body as { countId: unknown }).countId === "string"
      ? (body as { countId: string }).countId
      : "";
  if (!countId.trim()) {
    return jsonResponse({ ok: false, error: "countId は必須です" }, 400);
  }

  let completedGroups: CompletedGroup[] = [];
  const groupId = typeof body === "object" && body !== null && "groupId" in body ? (body as { groupId: unknown }).groupId : undefined;
  const itemsRaw = typeof body === "object" && body !== null && "items" in body ? (body as { items: unknown }).items : undefined;
  const completedGroupsRaw = typeof body === "object" && body !== null && "completedGroups" in body ? (body as { completedGroups: unknown }).completedGroups : undefined;

  if (retryOnly) {
    const backup = await readPendingCompleteBackup(admin);
    if (!backup || normalizeIdForMatch(backup.countId) !== normalizeIdForMatch(countId)) {
      return jsonResponse(
        { ok: false, error: "再試行用バックアップが見つかりません。棚卸を開き直してから確定してください。", needMetafieldRetry: true, countId },
        404
      );
    }
    completedGroups = backup.completedGroups;
    countId = backup.countId;
  } else if (Array.isArray(completedGroupsRaw) && completedGroupsRaw.length > 0) {
    for (const g of completedGroupsRaw) {
      if (typeof g !== "object" || g === null || !("groupId" in g) || !("items" in g)) continue;
      const groupIdStr = String((g as { groupId: unknown }).groupId);
      const itemsArr = (g as { items: unknown }).items;
      if (!groupIdStr || !Array.isArray(itemsArr)) continue;
      completedGroups.push({ groupId: groupIdStr, items: itemsArr as CompletedGroup["items"] });
    }
  } else if (typeof groupId === "string" && groupId.trim() && Array.isArray(itemsRaw)) {
    completedGroups = [{ groupId: groupId.trim(), items: itemsRaw as CompletedGroup["items"] }];
  }

  if (completedGroups.length === 0) {
    return jsonResponse({ ok: false, error: "groupId と items、または completedGroups が必要です" }, 400);
  }

  const completedGroupIds = completedGroups.map((g) => g.groupId);
  const backupPayload: PendingCompleteBackup = {
    countId,
    completedGroups,
    savedAt: new Date().toISOString(),
  };
  // バックアップ失敗でも POS はフルペイロード再送できるためメタ更新は続行する。
  // 失敗時は応答に backupPersisted:false を付け、Admin retryOnly の 404 リスクを明示する。
  const backupWrite = await writePendingCompleteBackup(admin, ownerId, backupPayload);
  const backupPersisted = backupWrite.ok;
  if (!backupPersisted) {
    console.warn(
      "[api.pos-stocktake-complete] pending_complete backup write failed (continuing apply):",
      backupWrite.error
    );
  }

  let lastError = "";
  for (let attempt = 1; attempt <= META_RETRY_MAX; attempt++) {
    try {
      const result = await applyPendingCompleteFromBackup(admin, ownerId, backupPayload);
      if (!result.ok) {
        const message = result.error || "ステータスの反映に失敗しました";
        lastError = message;
        if (message.includes("棚卸が見つかりません")) {
          return jsonResponse({ ok: false, error: message, needMetafieldRetry: false, countId }, 400);
        }
        if (isChunkCorruptionError(message)) {
          return jsonResponse(
            {
              ok: false,
              error:
                "棚卸データの一部が欠落しています。管理画面の棚卸一覧で「修復」を実行するか、サポートにお問い合わせください。",
              needMetafieldRetry: true,
              countId,
              completedGroupIds,
              backupPersisted,
            },
            200
          );
        }
        if (attempt < META_RETRY_MAX && isTransientMetaError(message)) {
          await sleep(META_RETRY_DELAY_MS * attempt);
          continue;
        }
        console.warn("STOCKTAKE_API_ORIGIN [server] response 200 ok:false needMetafieldRetry:", message);
        return jsonResponse(
          {
            ok: false,
            error: message,
            needMetafieldRetry: true,
            countId,
            completedGroupIds,
            backupPersisted,
          },
          200
        );
      }

      // Phase F: metafield 成功後に DB へ dual-write（失敗しても metafield 成功は維持）
      // apply が返した savedCount を使い、成功後の全チャンク再読込を避ける（応答遅延・切断対策）
      try {
        const saved = result.savedCount;
        if (saved) {
          await upsertInventoryCountDocument({
            shop,
            countId: String(saved.id),
            countName: saved.countName ?? null,
            status: String(saved.status || "in_progress"),
            locationId: saved.locationId ?? null,
            locationName: saved.locationName ?? null,
            payload: saved,
            completedAt: saved.completedAt ?? null,
          });
        }
      } catch (e: unknown) {
        console.warn(
          "[api.pos-stocktake-complete] DB dual-write skipped:",
          e instanceof Error ? e.message : String(e)
        );
      }

      console.warn(
        "STOCKTAKE_API_ORIGIN [server] response 200 ok:true (success) attempt=" +
          attempt +
          " status=" +
          (result.status ?? "?")
      );
      return jsonResponse(
        {
          ok: true,
          status: result.status ?? "in_progress",
          completedAt: result.completedAt,
          countId: result.countId,
          backupPersisted,
        },
        200
      );
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error("[api.pos-stocktake-complete] attempt failed:", lastError);
      if (isChunkCorruptionError(lastError)) {
        return jsonResponse(
          {
            ok: false,
            error: lastError,
            needMetafieldRetry: true,
            countId,
            completedGroupIds,
            backupPersisted,
          },
          200
        );
      }
      if (attempt < META_RETRY_MAX && isTransientMetaError(lastError)) {
        await sleep(META_RETRY_DELAY_MS * attempt);
        continue;
      }
      break;
    }
  }

  console.warn("STOCKTAKE_API_ORIGIN [server] response 200 ok:false needMetafieldRetry after retries:", lastError);
  return jsonResponse(
    {
      ok: false,
      error: lastError || "ステータスの反映に失敗しました。再試行してください。",
      needMetafieldRetry: true,
      countId,
      completedGroupIds,
      backupPersisted,
    },
    200
  );
}
