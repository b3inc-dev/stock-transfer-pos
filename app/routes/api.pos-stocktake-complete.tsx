// app/routes/api.pos-stocktake-complete.tsx
// POS 棚卸確定完了報告を受け、メタフィールドをサーバー側で 1 回 read → 更新 → 1 回 write する API

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import type { SessionStorageWithFindByShop } from "../types";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { refreshOfflineSessionIfNeeded } from "../utils/refresh-offline-session";
import {
  readInventoryCountsChunked,
  writeInventoryCountsChunked,
  getGroupItemsByKey,
  normalizeIdForMatch,
  type InventoryCount,
} from "./app.inventory-count";

const API_VERSION = "2026-01";

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

export async function loader({ request }: LoaderFunctionArgs) {
  // 履歴API と同様: CORS プリフライトが届いているかログで確認できるようにする
  if (request.method === "OPTIONS") {
    console.log("[api.pos-stocktake-complete] CORS preflight (OPTIONS) received");
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  // 原因特定用: POST が届いたかどうかで「クライアントで失敗」vs「サーバーで失敗」を切り分け（Render ログで STOCKTAKE_API_ORIGIN を検索）
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
  let sessions = await storage.findSessionsByShop(shop);
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
  let admin = {
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
  const countId =
    typeof body === "object" && body !== null && "countId" in body && typeof (body as { countId: unknown }).countId === "string"
      ? (body as { countId: string }).countId
      : "";
  if (!countId.trim()) {
    return jsonResponse({ ok: false, error: "countId は必須です" }, 400);
  }

  type ItemEntry = {
    inventoryItemId: string;
    currentQuantity: number;
    actualQuantity: number;
    variantId?: string;
    sku?: string;
    title?: string;
  };
  type CompletedGroup = { groupId: string; items: ItemEntry[] };

  let completedGroups: CompletedGroup[] = [];
  const groupId = typeof body === "object" && body !== null && "groupId" in body ? (body as { groupId: unknown }).groupId : undefined;
  const itemsRaw = typeof body === "object" && body !== null && "items" in body ? (body as { items: unknown }).items : undefined;
  const completedGroupsRaw = typeof body === "object" && body !== null && "completedGroups" in body ? (body as { completedGroups: unknown }).completedGroups : undefined;

  if (Array.isArray(completedGroupsRaw) && completedGroupsRaw.length > 0) {
    for (const g of completedGroupsRaw) {
      if (typeof g !== "object" || g === null || !("groupId" in g) || !("items" in g)) continue;
      const groupIdStr = String((g as { groupId: unknown }).groupId);
      const itemsArr = (g as { items: unknown }).items;
      if (!groupIdStr || !Array.isArray(itemsArr)) continue;
      completedGroups.push({ groupId: groupIdStr, items: itemsArr as ItemEntry[] });
    }
  } else if (typeof groupId === "string" && groupId.trim() && Array.isArray(itemsRaw)) {
    completedGroups = [{ groupId: groupId.trim(), items: itemsRaw as ItemEntry[] }];
  }

  if (completedGroups.length === 0) {
    return jsonResponse({ ok: false, error: "groupId と items、または completedGroups が必要です" }, 400);
  }

  let inventoryCounts: InventoryCount[];
  try {
    inventoryCounts = await readInventoryCountsChunked(admin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api.pos-stocktake-complete] readInventoryCountsChunked failed:", msg);
    // チャンク欠損のときはメッセージをそのまま返し、管理画面での修復を促す
    if (/棚卸チャンク\d+が存在しません/.test(msg)) {
      return jsonResponse(
        { ok: false, error: "棚卸データの一部（メタフィールド）が欠落しています。管理画面の棚卸一覧で「修復」を実行するか、サポートにお問い合わせください。" },
        500
      );
    }
    return jsonResponse({ ok: false, error: "棚卸データの読み取りに失敗しました。しばらくしてから再試行してください。" }, 500);
  }

  const count = inventoryCounts.find(
    (c) => String(c.id) === String(countId) || normalizeIdForMatch((c as { id?: string }).id) === normalizeIdForMatch(countId)
  );
  if (!count) {
    return jsonResponse({ ok: false, error: "棚卸が見つかりません" }, 400);
  }

  const groupItemsMap: Record<string, unknown[]> =
    (count as { groupItems?: Record<string, unknown[]> }).groupItems && typeof (count as { groupItems?: unknown }).groupItems === "object"
      ? { ...((count as { groupItems: Record<string, unknown[]> }).groupItems) }
      : {};

  for (const { groupId: gid, items } of completedGroups) {
    const entry = items.map((i) => ({
      inventoryItemId: i.inventoryItemId,
      variantId: i.variantId,
      sku: i.sku ?? "",
      title: i.title ?? "",
      currentQuantity: Number(i.currentQuantity),
      actualQuantity: Number(i.actualQuantity),
      delta: Number(i.actualQuantity) - Number(i.currentQuantity),
    }));
    const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(gid)) ?? gid;
    groupItemsMap[key] = entry;
  }

  const allIds =
    Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0
      ? count.productGroupIds
      : (count as { productGroupId?: string }).productGroupId
        ? [(count as { productGroupId: string }).productGroupId]
        : [];
  const allDone = allIds.length > 0 && allIds.every((id) => getGroupItemsByKey(groupItemsMap, id).length > 0);

  const updatedCounts: InventoryCount[] = inventoryCounts.map((c) => {
    if (String(c.id) !== String(countId) && normalizeIdForMatch((c as { id?: string }).id) !== normalizeIdForMatch(countId)) {
      return c;
    }
    return {
      ...c,
      groupItems: groupItemsMap,
      status: allDone ? ("completed" as const) : ("in_progress" as const),
      completedAt: allDone ? new Date().toISOString() : undefined,
    };
  });

  const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts, ownerId);
  if (userErrors.length > 0) {
    const message = userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "保存に失敗しました";
    console.warn("STOCKTAKE_API_ORIGIN [server] response 200 ok:false (write userErrors):", message);
    return jsonResponse({ ok: false, error: message }, 200);
  }

  console.warn("STOCKTAKE_API_ORIGIN [server] response 200 ok:true (success)");
  return jsonResponse({ ok: true }, 200);
}
