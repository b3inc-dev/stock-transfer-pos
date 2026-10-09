/**
 * loss / adjustment / purchase / order_request の DB 保存 + 任意 metafield ミラー
 */
import { replaceEntriesForShop, type AppEntryLike } from "./app-entry-document.server";
import { shouldWriteMetafield, type AppEntryType } from "./metafield-db-sot";

const NS = "stock_transfer_pos";

const V1_KEYS: Record<AppEntryType, string> = {
  loss: "loss_entries_v1",
  adjustment: "adjustment_entries_v1",
  purchase: "purchase_entries_v1",
  order_request: "order_request_entries_v1",
};

export async function persistEntriesForShop(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  ownerId: string,
  shop: string,
  entryType: AppEntryType,
  entries: AppEntryLike[]
): Promise<{ ok: boolean; error?: string }> {
  if (!shop) return { ok: false, error: "shop が必要です" };
  const dbRes = await replaceEntriesForShop(shop, entryType, entries);
  if (!dbRes.ok) return { ok: false, error: dbRes.error || `${entryType} の DB 保存に失敗しました` };
  if (!shouldWriteMetafield("entries")) return { ok: true };

  const key = V1_KEYS[entryType];
  const saveResp = await admin.graphql(
    `#graphql
      mutation SaveAppEntries($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: NS,
            key,
            type: "json",
            value: JSON.stringify(entries),
          },
        ],
      },
    }
  );
  const saveJson = (await saveResp.json()) as {
    data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
  };
  const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
  if (errs.length) {
    // DB は既に SoT。ミラー失敗は警告のみ（再試行で DB を壊さない）
    console.warn(
      `[persist-app-entries] metafield mirror failed after DB ok (${entryType}):`,
      errs.map((e) => e.message ?? "").join(" / ")
    );
  }
  return { ok: true };
}
