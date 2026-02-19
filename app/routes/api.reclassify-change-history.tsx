// app/routes/api.reclassify-change-history.tsx
// 在庫変動履歴の「管理」行を一括で正しいアクティビティに振り直す救済API（運用・手動実行用）
// 名古屋パルコのように「本当はアプリPOSから入庫したが API が届かず管理のまま」の行を入庫に揃える用途。
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

const ALLOWED_ACTIVITIES = [
  "inbound_transfer",
  "outbound_transfer",
  "loss_entry",
  "inventory_count",
  "purchase_entry",
  "purchase_cancel",
] as const;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.RECLASSIFY_CHANGE_HISTORY_API_KEY || process.env.INVENTORY_SNAPSHOT_API_KEY;
  const authHeader = request.headers.get("Authorization");
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const {
      shop,
      locationId,
      locationIds,
      fromTime,
      toTime,
      activity,
      sourceId = null,
      clearStaleNoteOnly = false,
    } = body as {
      shop?: string;
      locationId?: string;
      locationIds?: string[];
      fromTime?: string;
      toTime?: string;
      activity?: string;
      sourceId?: string | null;
      clearStaleNoteOnly?: boolean;
    };

    if (!shop) {
      return new Response(JSON.stringify({ ok: false, error: "shop is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 備考のみクリア（「変動数は直前ログが…」を既知アクティビティ行から削除）
    if (clearStaleNoteOnly) {
      const staleNoteSubstring = "変動数は直前ログが";
      const updated = await (db as any).inventoryChangeLog.updateMany({
        where: {
          shop,
          note: { contains: staleNoteSubstring },
          activity: { not: "admin_webhook" },
        },
        data: { note: null },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          message: "Stale note cleared",
          updated: updated?.count ?? 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 管理 → 指定アクティビティに振り直し
    const locs = locationIds ?? (locationId ? [locationId] : []);
    if (locs.length === 0 || !fromTime || !toTime || !activity) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "locationId or locationIds, fromTime, toTime, and activity are required for reclassify",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!ALLOWED_ACTIVITIES.includes(activity as any)) {
      return new Response(
        JSON.stringify({ ok: false, error: `activity must be one of: ${ALLOWED_ACTIVITIES.join(", ")}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const from = new Date(fromTime);
    const to = new Date(toTime);
    const locationIdCandidates = locs.flatMap((id: string) => {
      const raw = id.replace(/^gid:\/\/shopify\/Location\//, "");
      return [raw, id, raw !== id ? `gid://shopify/Location/${raw}` : ""].filter(Boolean);
    });

    const updated = await (db as any).inventoryChangeLog.updateMany({
      where: {
        shop,
        locationId: { in: locationIdCandidates },
        timestamp: { gte: from, lte: to },
        activity: "admin_webhook",
      },
      data: {
        activity,
        sourceType: activity,
        sourceId: sourceId ?? null,
        note: null,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Reclassified",
        updated: updated?.count ?? 0,
        shop,
        locationIds: locs,
        fromTime: from.toISOString(),
        toTime: to.toISOString(),
        activity,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api.reclassify-change-history] Error:", e);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
