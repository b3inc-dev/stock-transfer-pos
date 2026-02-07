// app/routes/api.log-inventory-change.tsx
// POS UI Extensionから在庫変動ログを記録するAPIエンドポイント

import type { ActionFunctionArgs } from "react-router";
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

export async function action({ request }: ActionFunctionArgs) {
  try {
    const authResult = await authenticate.public(request);
    const { admin, session } = authResult;

    if (!session) {
      return new Response(
        JSON.stringify({ ok: false, error: "No session found" }),
        { 
          status: 401,
          headers: { "Content-Type": "application/json" }
        }
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
        { 
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
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
        { 
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Webhook が先に届いて「管理」で保存されている場合、同じ変動として種別を上書きする（履歴でロス・仕入等と表示するため）
    const ts = timestamp ? new Date(timestamp) : new Date();
    const recentFrom = new Date(ts.getTime() - 5 * 60 * 1000); // 5分前まで遡る
    const recentTo = new Date(ts.getTime() + 2 * 60 * 1000);   // 2分後まで（Webhook遅延を考慮）
    const rawItemId = toRawId(inventoryItemId);
    const rawLocId = toRawId(locationId);
    const qtyAfter = quantityAfter !== undefined && quantityAfter !== null ? Number(quantityAfter) : null;
    const recentAdminLog = await (db as any).inventoryChangeLog.findFirst({
      where: {
        shop: session.shop,
        inventoryItemId: rawItemId,
        locationId: rawLocId,
        quantityAfter: qtyAfter,
        activity: "admin_webhook",
        timestamp: { gte: recentFrom, lte: recentTo },
      },
      orderBy: { timestamp: "desc" },
    });
    if (recentAdminLog) {
      await (db as any).inventoryChangeLog.update({
        where: { id: recentAdminLog.id },
        data: {
          activity,
          sourceType: activity,
          sourceId: sourceId || null,
          adjustmentGroupId: adjustmentGroupId || null,
          // Webhook が先に保存したとき delta が null になり「変動数: -」になるため、API で上書きする
          ...(delta !== undefined && delta !== null ? { delta: Number(delta) } : {}),
          ...(quantityAfter !== undefined && quantityAfter !== null ? { quantityAfter: Number(quantityAfter) } : {}),
        },
      });
      console.log(`[api.log-inventory-change] Updated admin_webhook to ${activity} (id=${recentAdminLog.id}, item=${rawItemId}, location=${rawLocId}, quantityAfter=${qtyAfter}, delta=${delta})`);
      return new Response(
        JSON.stringify({ ok: true, updated: true, id: recentAdminLog.id }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // 在庫変動ログを保存
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
        delta: delta !== undefined ? delta : null,
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
      { 
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (e: any) {
    console.error("[api.log-inventory-change] Error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Unknown error", stack: e?.stack }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
