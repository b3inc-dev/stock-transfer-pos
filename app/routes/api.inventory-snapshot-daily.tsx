// app/routes/api.inventory-snapshot-daily.tsx
// 日次スナップショット自動保存API（Cronジョブから呼び出し用）
import type { ActionFunctionArgs } from "react-router";
import { sessionStorage } from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone, getHourInShopTimezone } from "../utils/timezone";
import {
  getSavedSnapshots,
  fetchAllInventoryItems,
  aggregateSnapshotsFromItems,
  saveSnapshotsForDate,
} from "../utils/inventory-snapshot";
import { refreshOfflineSessionIfNeeded } from "../utils/refresh-offline-session";

export type { DailyInventorySnapshot, InventorySnapshotsData } from "../utils/inventory-snapshot";

const API_VERSION = "2025-10";

/** 同時に処理するショップ数（ストア増加時の実行時間短縮用）。環境変数 SNAPSHOT_CONCURRENCY で上書き可能 */
const DEFAULT_CONCURRENCY = 3;

/** 1 ショップ分のスナップショット保存を行う。並列実行用。 */
async function processOneShop(sessionRecord: {
  id: string;
  shop: string;
  expires: Date | null;
  refreshToken: string | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    await refreshOfflineSessionIfNeeded(
      sessionRecord.id,
      sessionRecord.shop,
      sessionRecord.expires,
      sessionRecord.refreshToken
    );

    const session = await sessionStorage.loadSession(sessionRecord.id);
    if (!session) {
      return { success: false, error: `${sessionRecord.shop}: Session not found` };
    }

    const shopDomain = session.shop;
    const accessToken = session.accessToken || "";
    const admin = {
      request: async (queryOrOpts: string | { data?: string; variables?: any }, maybeVars?: any) => {
        const queryStr = typeof queryOrOpts === "string" ? queryOrOpts : (queryOrOpts.data || "");
        const variables = typeof queryOrOpts === "string" ? (maybeVars?.variables ?? maybeVars ?? {}) : (queryOrOpts.variables || {});
        const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: queryStr.replace(/^#graphql\s*/m, "").trim(),
            variables: variables || {},
          }),
        });
        return res;
      },
    };

    const adminForSnapshot = {
      request: async (opts: { data: string; variables?: Record<string, unknown> }) =>
        admin.request(opts.data, opts.variables ?? {}),
    };

    const { shopId, shopTimezone, savedSnapshots } = await getSavedSnapshots(adminForSnapshot);

    const now = new Date();
    const hourInShop = getHourInShopTimezone(now, shopTimezone);
    const isEndOfDayRun = hourInShop === 23;
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const dateToSaveStr = isEndOfDayRun
      ? getDateInShopTimezone(now, shopTimezone)
      : getDateInShopTimezone(yesterdayDate, shopTimezone);

    const allItems = await fetchAllInventoryItems(adminForSnapshot);
    const newSnapshots = aggregateSnapshotsFromItems(allItems, dateToSaveStr);
    const { userErrors } = await saveSnapshotsForDate(
      adminForSnapshot,
      shopId,
      savedSnapshots,
      newSnapshots,
      dateToSaveStr
    );

    if (userErrors.length > 0) {
      return { success: false, error: `${sessionRecord.shop}: ${userErrors.map((e: any) => e.message).join(", ")}` };
    }
    console.log(`Auto-saved snapshot for ${sessionRecord.shop} (${dateToSaveStr}${isEndOfDayRun ? ", 23:59 run" : ", 0:00 run"})`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error processing ${sessionRecord.shop}:`, error);
    return { success: false, error: `${sessionRecord.shop}: ${message}` };
  }
}

/** 配列を指定サイズのチャンクに分割 */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    // APIキーで認証（Cronジョブからの呼び出し用）
    const authHeader = request.headers.get("Authorization");
    const expectedApiKey = process.env.INVENTORY_SNAPSHOT_API_KEY;
    
    if (!expectedApiKey || authHeader !== `Bearer ${expectedApiKey}`) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 全ショップのセッションを取得（オフラインアクセストークン）
    const sessions = await db.session.findMany({
      where: {
        isOnline: false, // オフラインアクセストークンのみ
      },
    });

    if (sessions.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "No shops to process", processed: 0 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const concurrency = Math.max(1, Math.min(10, parseInt(process.env.SNAPSHOT_CONCURRENCY ?? "", 10) || DEFAULT_CONCURRENCY));
    const chunks = chunk(sessions, concurrency);
    const errors: string[] = [];
    let processedCount = 0;

    for (const batch of chunks) {
      const results = await Promise.all(batch.map((s) => processOneShop(s)));
      for (const r of results) {
        if (r.success) processedCount++;
        else if (r.error) errors.push(r.error);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        message: `Processed ${processedCount} shops`,
        processed: processedCount,
        total: sessions.length,
        errors: errors.length > 0 ? errors : undefined,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Daily snapshot API error:", error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save snapshots",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
