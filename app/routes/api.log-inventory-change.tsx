// app/routes/api.log-inventory-change.tsx
// POS UI Extensionから在庫変動ログを記録するAPIエンドポイント

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";

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

// CORS プリフライト（OPTIONS）用。POS から fetch する前に OPTIONS が飛び、これが 400 だと POST が送られない
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
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
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    // デバッグ: トークン payload を検証せずに読んで aud/iss/dest をログ（本番アプリ経由でも 401 になる場合の切り分け用）
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        console.warn("[api.log-inventory-change] Token payload (unverified):", {
          aud: payload.aud,
          iss: payload.iss,
          dest: payload.dest,
          exp: payload.exp,
          apiKey: process.env.SHOPIFY_API_KEY ? `${process.env.SHOPIFY_API_KEY.slice(0, 8)}...` : "(not set)",
        });
      }
    } catch (_) {
      /* ignore decode errors */
    }

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

    // オフラインセッションを取得（Admin API と DB 用）
    const sessions = await (sessionStorage as any).findSessionsByShop(shop);
    const session = sessions?.find((s: any) => s.isOnline === false) ?? sessions?.[0];
    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "No session found for shop" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const shopDomain = session.shop;
    const accessToken = session.accessToken;
    const admin = {
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

    const body = await request.json();
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
    } = body;

    if (!inventoryItemId || !locationId || !activity) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const rawItemIdLog = toRawId(inventoryItemId);
    const rawLocIdLog = toRawId(locationId);
    const qtyAfterLog = quantityAfter !== undefined && quantityAfter !== null ? Number(quantityAfter) : null;
    console.log(`[api.log-inventory-change] Called: shop=${session.shop}, activity=${activity}, item=${rawItemIdLog}, location=${rawLocIdLog}, quantityAfter=${qtyAfterLog}, delta=${delta}`);

    // タイムゾーンと日付を取得
    const shopTimezoneResp = await admin.request({
      data: `
        #graphql
        query GetShopTimezone {
          shop {
            ianaTimezone
          }
        }
      `,
    });
    const shopTimezoneData = await shopTimezoneResp.json();
    const shopTimezone = shopTimezoneData?.data?.shop?.ianaTimezone || "UTC";
    const date = getDateInShopTimezone(timestamp ? new Date(timestamp) : new Date(), shopTimezone);

    // idempotencyKeyを生成（重複防止）
    const idempotencyKey = `${session.shop}:${inventoryItemId}:${locationId}:${timestamp || new Date().toISOString()}:${quantityAfter || 0}`;

    // 既に同じidempotencyKeyのログが存在する場合はスキップ（二重登録防止）
    const existingLog = await (db as any).inventoryChangeLog.findUnique({
      where: {
        shop_idempotencyKey: {
          shop: session.shop,
          idempotencyKey,
        },
      },
    });

    if (existingLog) {
      return new Response(
        JSON.stringify({ ok: true, message: "Log already exists", id: existingLog.id }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // Webhook が先に届いて「管理」で保存されている場合、同じ変動として種別・変動数を上書きする。
    // quantityAfter は検索条件に含めない（拡張側と Webhook で微妙にずれるとヒットしないため）。同一 item+location+時間帯の直近1件を更新する。
    const ts = timestamp ? new Date(timestamp) : new Date();
    const recentFrom = new Date(ts.getTime() - 10 * 60 * 1000); // 10分前まで遡る
    const recentTo = new Date(ts.getTime() + 5 * 60 * 1000);    // 5分後まで（Webhook/API 遅延を考慮）
    const rawItemId = toRawId(inventoryItemId);
    const rawLocId = toRawId(locationId);
    const recentAdminLog = await (db as any).inventoryChangeLog.findFirst({
      where: {
        shop: session.shop,
        inventoryItemId: rawItemId,
        locationId: rawLocId,
        activity: "admin_webhook",
        timestamp: { gte: recentFrom, lte: recentTo },
      },
      orderBy: { timestamp: "desc" },
    });
    if (recentAdminLog) {
      // 拡張から受け取った数量（delta・quantityAfter）を相違なく反映する
      const updateData: Record<string, unknown> = {
        activity,
        sourceType: activity,
        sourceId: sourceId || null,
        adjustmentGroupId: adjustmentGroupId || null,
      };
      if (delta !== undefined && delta !== null) updateData.delta = Number(delta);
      if (quantityAfter !== undefined && quantityAfter !== null) updateData.quantityAfter = Number(quantityAfter);
      await (db as any).inventoryChangeLog.update({
        where: { id: recentAdminLog.id },
        data: updateData,
      });
      console.log(`[api.log-inventory-change] Updated admin_webhook to ${activity} (id=${recentAdminLog.id}, item=${rawItemId}, location=${rawLocId}, delta=${delta}, quantityAfter=${quantityAfter})`);
      return new Response(
        JSON.stringify({ ok: true, updated: true, id: recentAdminLog.id }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // 在庫変動ログを保存（変動数は拡張から受け取った値をそのまま反映）。IDはraw形式で統一（Webhook・検索と一致）
    const log = await (db as any).inventoryChangeLog.create({
      data: {
        shop: session.shop,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        date,
        inventoryItemId: rawItemIdLog,
        variantId: variantId || null,
        sku: sku || "",
        locationId: rawLocIdLog,
        locationName: locationName || locationId,
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

    return new Response(
      JSON.stringify({ ok: true, id: log.id }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (e: any) {
    console.error("[api.log-inventory-change] Error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Unknown error", stack: e?.stack }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}
