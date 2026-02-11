// app/routes/api.log-inventory-change.tsx
// POS UI Extensionから在庫変動ログを記録するAPIエンドポイント

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";
import { refreshOfflineSessionIfNeeded } from "../utils/refresh-offline-session";

const API_VERSION = "2025-10";

// dest が "https://xxx.myshopify.com" のときホスト名だけにする（findSessionsByShop は "xxx.myshopify.com" で保存されている）
function shopFromDest(dest: string): string {
  try {
    const u = new URL(dest);
    return u.hostname;
  } catch {
    return dest;
  }
}

// HMAC キーを秘密鍵文字列から作成（Shopify の decodeSessionToken と同じ方式）
function secretToKey(secret: string): Uint8Array {
  const key = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) key[i] = secret.charCodeAt(i);
  return key;
}

// POS トークンを jose で検証（authenticate.pos が 401 になる場合の代替用・ビルドで内部パスを参照しない）
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
  } catch (e: any) {
    console.warn("[api.log-inventory-change] decodeSessionToken error:", e?.message || String(e));
    return null;
  }
}

// Webhook は数値IDで保存するため、GID の場合は末尾の数値に正規化して照合する
function toRawId(id: string | number | null | undefined): string {
  if (id == null) return "";
  const s = String(id).trim();
  if (s.startsWith("gid://")) {
    const last = s.split("/").pop();
    return last || s;
  }
  return s;
}

// GraphQL 用に locationId を GID に正規化する
function toLocationGid(locationId: string, rawLocId: string): string {
  const s = String(locationId || "").trim();
  if (s.startsWith("gid://")) return s;
  if (rawLocId) return `gid://shopify/Location/${rawLocId}`;
  return s;
}

// ロケーション名が未設定またはラベル（出庫元）のとき、GraphQL で実ロケーション名を取得する
async function resolveLocationName(
  admin: { request: (opts: { data: string; variables?: any }) => Promise<Response> },
  locationId: string,
  rawLocId: string
): Promise<string> {
  try {
    const gid = toLocationGid(locationId, rawLocId);
    const locationResp = await admin.request({
      data: `#graphql
        query GetLocation($id: ID!) {
          location(id: $id) {
            id
            name
          }
        }
      `,
      variables: { id: gid },
    });
    const locationData = await locationResp.json();
    const name = locationData?.data?.location?.name;
    return typeof name === "string" && name.trim() ? name.trim() : rawLocId || locationId;
  } catch (e: any) {
    console.warn("[api.log-inventory-change] resolveLocationName error:", e?.message || String(e));
    return rawLocId || locationId;
  }
}

// CORS プリフライト（OPTIONS）用。POS から fetch する前に OPTIONS が飛び、これが 400 だと POST が送られない
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export async function loader({ request }: LoaderFunctionArgs) {
  // CORSプリフライトリクエスト（OPTIONS）のログを追加
  console.log(`[api.log-inventory-change] Loader called: method=${request.method}, url=${request.url}, origin=${request.headers.get("origin") || "none"}`);
  if (request.method === "OPTIONS") {
    console.log(`[api.log-inventory-change] CORS preflight (OPTIONS) request received`);
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    // デバッグログ: APIが呼ばれたことを記録
    console.log(`[api.log-inventory-change] API endpoint called: method=${request.method}, url=${request.url}`);
    
    // 401 の原因切り分け: トークン未送信 vs トークン検証失敗（秘密鍵不一致など）
    const authHeader = request.headers.get("authorization");
    const hasAuth = authHeader?.startsWith("Bearer ");
    if (!hasAuth) {
      console.warn("[api.log-inventory-change] No Authorization Bearer header");
      return new Response(
        JSON.stringify({ ok: false, error: "Missing session token" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();

    // 先に自前 decode を試す（成功すれば authenticate.pos の 401 を回避し、失敗時はエラー内容をログに出す）
    let sessionToken: { dest?: string } | null = await decodePOSToken(token);
    if (!sessionToken?.dest) {
      try {
        const auth = await authenticate.pos(request);
        sessionToken = auth.sessionToken;
      } catch (err: any) {
        const is401 = err?.status === 401 || (err instanceof Response && err.status === 401);
        console.warn("[api.log-inventory-change] POS auth failed:", is401 ? "Session token invalid. 上記の decodeSessionToken error を確認してください。" : String(err?.message || err));
        throw err;
      }
    }
    const dest = typeof sessionToken.dest === "string" ? sessionToken.dest : (sessionToken as any).dest;
    if (!dest) {
      return new Response(
        JSON.stringify({ ok: false, error: "No shop in session token" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    const shop = shopFromDest(dest);

    const body = await request.json();
    // バッチ: body.entries が配列なら複数件、なければ body 1件として扱う（後方互換）
    const entries: any[] = Array.isArray(body?.entries) && body.entries.length > 0 ? body.entries : [body];
    
    console.log(`[api.log-inventory-change] Request received: shop=${shop}, entries.length=${entries.length}, activities=${entries.map((e: any) => e?.activity).join(", ")}`);

    let sessions = await (sessionStorage as any).findSessionsByShop(shop);
    let session = sessions?.find((s: any) => s.isOnline === false) ?? sessions?.[0];

    // オフラインアクセストークンが期限切れならリフレッシュ（在庫変動履歴の記録に同じトークンを使用するため）
    if (session) {
      const expiresDate = session.expires != null
        ? new Date(typeof session.expires === "number" ? session.expires : (session.expires as Date).getTime())
        : null;
      await refreshOfflineSessionIfNeeded(session.id, session.shop, expiresDate, session.refreshToken ?? null);
      const sessionsAfter = await (sessionStorage as any).findSessionsByShop(shop);
      session = sessionsAfter?.find((s: any) => s.isOnline === false) ?? sessionsAfter?.[0];
    }

    let shopTimezone = "UTC";
    let admin: { request: (opts: { data: string; variables?: any }) => Promise<Response> } | null = null;
    if (session) {
      const shopDomain = session.shop;
      const accessToken = session.accessToken;
      admin = {
        request: async (options: { data: string; variables?: any }) => {
          return fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({
              query: options.data.replace(/^#graphql\s*/m, "").trim(),
              variables: options.variables || {},
            }),
          });
        },
      };
      const shopTimezoneResp = await admin.request({
        data: `#graphql
          query GetShopTimezone { shop { ianaTimezone } }
        `,
      });
      const shopTimezoneData = await shopTimezoneResp.json();
      shopTimezone = shopTimezoneData?.data?.shop?.ianaTimezone || "UTC";
    }

    const results: Array<{ ok: boolean; id?: number; updated?: boolean; message?: string; error?: string }> = [];
    for (const singleBody of entries) {
      const {
        inventoryItemId,
        variantId,
        sku,
        locationId,
        locationName,
        activity,
        delta,
        quantityAfter,
        sourceId,
        adjustmentGroupId,
        timestamp,
      } = singleBody;

      if (!inventoryItemId || !locationId || !activity) {
        console.warn(`[api.log-inventory-change] Missing required fields: inventoryItemId=${!!inventoryItemId}, locationId=${!!locationId}, activity=${!!activity}`);
        results.push({ ok: false, error: "Missing required fields" });
        continue;
      }
      
      console.log(`[api.log-inventory-change] Processing entry: activity=${activity}, inventoryItemId=${inventoryItemId}, locationId=${locationId}, delta=${delta}`);

      const rawItemId = toRawId(inventoryItemId);
      const rawLocId = toRawId(locationId);
      const ts = timestamp ? new Date(timestamp) : new Date();
      const date = getDateInShopTimezone(ts, shopTimezone);
      // idempotencyKeyの生成: sourceIdがある場合はそれを使用、ない場合はタイムスタンプを秒単位に丸めて使用
      // quantityAfterは含めない（同じ操作でもquantityAfterが異なる可能性があるため）
      const tsRounded = timestamp ? new Date(Math.floor(new Date(timestamp).getTime() / 1000) * 1000) : new Date(Math.floor(ts.getTime() / 1000) * 1000);
      const idempotencyKey = sourceId 
        ? `${shop}_${activity}_${inventoryItemId}_${locationId}_${sourceId}`
        : `${shop}_${activity}_${inventoryItemId}_${locationId}_${tsRounded.toISOString()}`;

      // 入庫・出庫・仕入・ロス・棚卸で変動があったロケーション名を確実に保存する。
      // 未設定またはラベル（出庫元）のときは GraphQL で実ロケーション名を取得する。
      let resolvedLocationName = typeof locationName === "string" ? locationName.trim() : "";
      if (admin && (!resolvedLocationName || resolvedLocationName === "出庫元")) {
        resolvedLocationName = await resolveLocationName(admin, locationId, rawLocId);
      }
      if (!resolvedLocationName) resolvedLocationName = rawLocId || String(locationId || "");

      if (!session) {
        const dateUtc = getDateInShopTimezone(ts, "UTC");
        const existingLog = await (db as any).inventoryChangeLog.findUnique({
          where: { shop_idempotencyKey: { shop, idempotencyKey } },
        });
        if (existingLog) {
          results.push({ ok: true, message: "Log already exists", id: existingLog.id });
          continue;
        }
        // 検索範囲を30分前〜5分後に拡大（inventory_levels/updateとのタイムスタンプのずれを考慮）
        const recentFrom = new Date(ts.getTime() - 30 * 60 * 1000);
        const recentTo = new Date(ts.getTime() + 5 * 60 * 1000);
        // inventory_levels/update Webhookは数値ID形式で保存しているが、念のため両方の形式を候補として検索
        const inventoryItemIdCandidates = [
          rawItemId,
          `gid://shopify/InventoryItem/${rawItemId}`,
        ];
        const locationIdCandidates = [
          rawLocId,
          `gid://shopify/Location/${rawLocId}`,
        ];
        const recentAdminLog = await (db as any).inventoryChangeLog.findFirst({
          where: {
            shop,
            inventoryItemId: { in: inventoryItemIdCandidates },
            locationId: { in: locationIdCandidates },
            activity: "admin_webhook",
            timestamp: { gte: recentFrom, lte: recentTo },
          },
          orderBy: { timestamp: "desc" },
        });
        if (recentAdminLog) {
          console.log(
            `[api.log-inventory-change] Found admin_webhook log to update: id=${recentAdminLog.id}, activity=${activity}, delta=${delta}, quantityAfter=${quantityAfter}`
          );
          const updateData: Record<string, unknown> = {
            activity,
            sourceType: activity,
            sourceId: sourceId || null,
            adjustmentGroupId: adjustmentGroupId || null,
            locationName: resolvedLocationName,
          };
          if (delta !== undefined && delta !== null) updateData.delta = Number(delta);
          if (quantityAfter !== undefined && quantityAfter !== null) updateData.quantityAfter = Number(quantityAfter);
          await (db as any).inventoryChangeLog.update({ where: { id: recentAdminLog.id }, data: updateData });
          console.log(`[api.log-inventory-change] Updated admin_webhook log: id=${recentAdminLog.id}, new activity=${activity}`);
          results.push({ ok: true, updated: true, id: recentAdminLog.id });
          continue;
        } else {
          console.log(
            `[api.log-inventory-change] No admin_webhook log found to update. Search criteria: shop=${shop}, inventoryItemIds=[${inventoryItemIdCandidates.join(", ")}], locationIds=[${locationIdCandidates.join(", ")}], timestamp between ${recentFrom.toISOString()} and ${recentTo.toISOString()}`
          );
        }
        const log = await (db as any).inventoryChangeLog.create({
          data: {
            shop,
            timestamp: ts,
            date: dateUtc,
            inventoryItemId: rawItemId,
            variantId: variantId || null,
            sku: sku || "",
            locationId: rawLocId,
            locationName: resolvedLocationName,
            activity,
            delta: delta !== undefined && delta !== null ? Number(delta) : null,
            quantityAfter: quantityAfter !== undefined ? quantityAfter : null,
            sourceType: activity,
            sourceId: sourceId || null,
            adjustmentGroupId: adjustmentGroupId || null,
            idempotencyKey,
            note: null,
          },
        });
        results.push({ ok: true, id: log.id });
        continue;
      }

      const shopId = session.shop;
      const existingLog = await (db as any).inventoryChangeLog.findUnique({
        where: { shop_idempotencyKey: { shop: shopId, idempotencyKey } },
      });
      if (existingLog) {
        results.push({ ok: true, message: "Log already exists", id: existingLog.id });
        continue;
      }
      // 検索範囲を30分前〜5分後に拡大（inventory_levels/updateとのタイムスタンプのずれを考慮）
      const recentFrom = new Date(ts.getTime() - 30 * 60 * 1000);
      const recentTo = new Date(ts.getTime() + 5 * 60 * 1000);
      // inventory_levels/update Webhookは数値ID形式で保存しているが、念のため両方の形式を候補として検索
      const inventoryItemIdCandidates = [
        rawItemId,
        `gid://shopify/InventoryItem/${rawItemId}`,
      ];
      const locationIdCandidates = [
        rawLocId,
        `gid://shopify/Location/${rawLocId}`,
      ];
      const recentAdminLog = await (db as any).inventoryChangeLog.findFirst({
        where: {
          shop: shopId,
          inventoryItemId: { in: inventoryItemIdCandidates },
          locationId: { in: locationIdCandidates },
          activity: "admin_webhook",
          timestamp: { gte: recentFrom, lte: recentTo },
        },
        orderBy: { timestamp: "desc" },
      });
      if (recentAdminLog) {
        console.log(
          `[api.log-inventory-change] Found admin_webhook log to update: id=${recentAdminLog.id}, activity=${activity}, delta=${delta}, quantityAfter=${quantityAfter}`
        );
        const updateData: Record<string, unknown> = {
          activity,
          sourceType: activity,
          sourceId: sourceId || null,
          adjustmentGroupId: adjustmentGroupId || null,
          locationName: resolvedLocationName,
        };
        if (delta !== undefined && delta !== null) updateData.delta = Number(delta);
        if (quantityAfter !== undefined && quantityAfter !== null) updateData.quantityAfter = Number(quantityAfter);
        await (db as any).inventoryChangeLog.update({ where: { id: recentAdminLog.id }, data: updateData });
        console.log(`[api.log-inventory-change] Updated admin_webhook log: id=${recentAdminLog.id}, new activity=${activity}`);
        results.push({ ok: true, updated: true, id: recentAdminLog.id });
        continue;
      } else {
        console.log(
          `[api.log-inventory-change] No admin_webhook log found to update. Search criteria: shop=${shopId}, inventoryItemIds=[${inventoryItemIdCandidates.join(", ")}], locationIds=[${locationIdCandidates.join(", ")}], timestamp between ${recentFrom.toISOString()} and ${recentTo.toISOString()}`
        );
      }
      const log = await (db as any).inventoryChangeLog.create({
        data: {
          shop: shopId,
          timestamp: timestamp ? new Date(timestamp) : new Date(),
          date,
          inventoryItemId: rawItemId,
          variantId: variantId || null,
          sku: sku || "",
          locationId: rawLocId,
          locationName: resolvedLocationName,
          activity,
          delta: delta !== undefined && delta !== null ? Number(delta) : null,
          quantityAfter: quantityAfter !== undefined ? quantityAfter : null,
          sourceType: activity,
          sourceId: sourceId || null,
          adjustmentGroupId: adjustmentGroupId || null,
          idempotencyKey,
          note: null,
        },
      });
      results.push({ ok: true, id: log.id });
    }

    const payload = entries.length === 1
      ? (results[0]?.ok ? results[0] : { ok: false, error: results[0]?.error ?? "Unknown" })
      : { ok: true, results };
    const status = entries.length === 1 && !results[0]?.ok ? 400 : 200;
    return new Response(
      JSON.stringify(payload),
      { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (e: any) {
    console.error("[api.log-inventory-change] Error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Unknown error", stack: e?.stack }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}
