// app/routes/api.log-inventory-change.tsx
// POS UI Extensionから在庫変動ログを記録するAPIエンドポイント

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";

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
    const authResult = await authenticate.public(request);
    const { admin, session } = authResult;

    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "No session found" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

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

    // 在庫変動ログを保存（変動数は拡張から受け取った値をそのまま反映）
    const log = await (db as any).inventoryChangeLog.create({
      data: {
        shop: session.shop,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        date,
        inventoryItemId,
        variantId: variantId || null,
        sku: sku || "",
        locationId,
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
