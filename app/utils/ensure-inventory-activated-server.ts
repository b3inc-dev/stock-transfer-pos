/**
 * サーバー側で「指定ロケーションに在庫レベルがないアイテム」を有効化する
 * api.inventory.apply-change で inventorySetQuantities の前に呼び、調整・棚卸で
 * 「The specified inventory item is not stocked at the location」を防ぐ。
 * 出庫・入庫・棚卸の POS 拡張と同様の処理。
 */

import type { AdminGraphql } from "./inventory-set-quantities-server";
import type {
  InventoryItemNode,
  NodesQueryData,
  InventoryItemUpdatePayload,
  InventoryActivatePayload,
} from "../types/graphql-responses";

function toLocationGid(locationId: string): string {
  const s = String(locationId || "").trim();
  if (s.startsWith("gid://")) return s;
  return s ? `gid://shopify/Location/${s}` : s;
}

function toInventoryItemGid(inventoryItemId: string): string | null {
  const str = String(inventoryItemId || "").trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

async function graphql(
  admin: { graphql: AdminGraphql },
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: Array<{ message?: string }> }> {
  const response = await admin.graphql(query.replace(/^#graphql\s*/m, "").trim(), { variables });
  const json = (await response.json().catch(() => ({}))) as {
    data?: unknown;
    errors?: Array<{ message?: string }>;
  };
  return json;
}

export type EnsureItem = { inventoryItemId: string; quantity: number };

export type EnsureResult = {
  ok: boolean;
  errors: Array<{ inventoryItemId: string; message: string }>;
};

export type VerifyLevelsResult = {
  ok: boolean;
  /** 読取成功かつ inventoryLevel 無しと判定できた GID */
  missingInventoryItemIds: string[];
  /** GraphQL/通信で確認できなかった GID（欠けているとは断定しない） */
  uncertainInventoryItemIds: string[];
};

/** activate / setQuantities 間の伝播待ち（Shopify inventoryLevel 反映） */
const POST_ACTIVATE_SETTLE_MS = 500;

/**
 * 指定ロケーションに inventoryLevel が存在するかを一括確認する。
 * apply-change で activate 成功後の再 ensure 対象選定に使う。
 * GraphQL 失敗は uncertain（missing に混ぜない）— setQuantities 前のハード失敗を避ける。
 */
export async function verifyInventoryLevelsAtLocation(
  admin: { graphql: AdminGraphql },
  locationId: string,
  inventoryItemIds: string[]
): Promise<VerifyLevelsResult> {
  const locationGid = toLocationGid(locationId);
  const ids = [
    ...new Set(
      (inventoryItemIds ?? [])
        .map((id) => toInventoryItemGid(id))
        .filter((x): x is string => !!x)
    ),
  ];
  if (!locationGid || ids.length === 0) {
    return { ok: true, missingInventoryItemIds: [], uncertainInventoryItemIds: [] };
  }

  const missing: string[] = [];
  const uncertain: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const result = await graphql(
        admin,
        `#graphql
          query VerifyInventoryLevels($ids: [ID!]!, $locationId: ID!) {
            nodes(ids: $ids) {
              ... on InventoryItem {
                id
                inventoryLevel(locationId: $locationId) { id }
              }
            }
          }`,
        { ids: chunk, locationId: locationGid }
      );
      if (result?.errors?.length) {
        uncertain.push(...chunk);
        continue;
      }
      const data = result?.data as NodesQueryData | undefined;
      const nodes: InventoryItemNode[] = Array.isArray(data?.nodes) ? data.nodes : [];
      const present = new Set(
        nodes
          .filter((n) => n?.inventoryLevel?.id)
          .map((n) => String(n.id || "").trim())
          .filter(Boolean)
      );
      const seen = new Set(nodes.map((n) => String(n?.id || "").trim()).filter(Boolean));
      for (const id of chunk) {
        if (present.has(id)) continue;
        // nodes に載らない（権限・削除等）は uncertain。明確に id があり level 無しだけ missing。
        if (seen.has(id)) missing.push(id);
        else uncertain.push(id);
      }
    } catch {
      uncertain.push(...chunk);
    }
  }
  return {
    ok: missing.length === 0 && uncertain.length === 0,
    missingInventoryItemIds: missing,
    uncertainInventoryItemIds: uncertain,
  };
}

/**
 * 指定ロケーションで在庫レベルがないアイテムを有効化する。
 * inventorySetQuantities は「ロケーションに在庫レベルがない」と失敗するため、確定前に実行する。
 */
export async function ensureInventoryActivatedAtLocation(
  admin: { graphql: AdminGraphql },
  locationId: string,
  items: EnsureItem[]
): Promise<EnsureResult> {
  const errors: Array<{ inventoryItemId: string; message: string }> = [];
  const locationGid = toLocationGid(locationId);
  if (!locationGid || !items?.length) {
    return { ok: true, errors: [] };
  }

  // 数値ID・GID混在をGIDに統一（Shopify APIはGIDを要求）
  const normalizedItems = items
    .map((x) => {
      const gid = toInventoryItemGid(x.inventoryItemId);
      return gid ? { inventoryItemId: gid, quantity: x.quantity } : null;
    })
    .filter((x): x is EnsureItem => x != null);
  if (normalizedItems.length === 0) {
    return { ok: true, errors: [] };
  }

  const quantityByItemId = new Map(normalizedItems.map((x) => [x.inventoryItemId, x.quantity]));
  const toProcess: Array<{ inventoryItemId: string; needsTrackedUpdate: boolean; needsActivate: boolean }> = [];

  const ids = normalizedItems.map((x) => x.inventoryItemId);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const result = await graphql(
        admin,
        `#graphql
          query CheckInventoryItems($ids: [ID!]!, $locationId: ID!) {
            nodes(ids: $ids) {
              ... on InventoryItem {
                id
                tracked
                inventoryLevel(locationId: $locationId) { id }
              }
            }
          }`,
        { ids: chunk, locationId: locationGid }
      );
      if (result?.errors?.length) {
        console.warn("[ensureInventoryActivatedAtLocation] CheckInventoryItems GraphQL errors:", result.errors);
        throw new Error(result.errors.map((e) => e?.message ?? String(e)).join(", "));
      }
      const data = result?.data as NodesQueryData | undefined;
      const nodes: InventoryItemNode[] = Array.isArray(data?.nodes) ? data.nodes : [];
      const processedIds = new Set<string>();
      for (const node of nodes) {
        const inventoryItemId = String(node?.id ?? "").trim();
        if (!inventoryItemId) continue;
        processedIds.add(inventoryItemId);
        const hasLevel = !!(node?.inventoryLevel?.id);
        const tracked = node?.tracked === true;
        if (!hasLevel || !tracked) {
          if (!tracked) {
            console.warn(
              `[ensureInventoryActivatedAtLocation] inventoryItem ${inventoryItemId} の在庫追跡 (tracked) が false です。` +
              `inventorySetQuantities の実行に必要なため自動で true に変更します。` +
              `ショップオーナーが意図的に追跡を無効にしている場合は設定を再確認してください。`
            );
          }
          toProcess.push({
            inventoryItemId,
            needsTrackedUpdate: !tracked,
            needsActivate: !hasLevel,
          });
        }
      }
      for (const id of chunk) {
        if (!processedIds.has(id)) {
          toProcess.push({
            inventoryItemId: id,
            needsTrackedUpdate: true,
            needsActivate: true,
          });
        }
      }
    } catch {
      for (const inventoryItemId of chunk) {
        toProcess.push({
          inventoryItemId,
          needsTrackedUpdate: true,
          needsActivate: true,
        });
      }
    }
  }

  const maxAttempts = 4;
  const delayMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let idx = 0; idx < toProcess.length; idx++) {
    const item = toProcess[idx];
    const { inventoryItemId, needsTrackedUpdate, needsActivate } = item;
    const initialQty = quantityByItemId.get(inventoryItemId);
    if (idx > 0) await delayMs(150);

    let lastError: string | null = null;
    let succeeded = false;
    // needsTrackedUpdate が失敗した場合に needsActivate をスキップするためのフラグ
    let trackedUpdateFailed = false;

    for (let attempt = 1; attempt <= maxAttempts && !succeeded; attempt++) {
      try {
        if (needsTrackedUpdate && !trackedUpdateFailed) {
          const updateRes = await graphql(
            admin,
            `#graphql
              mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                  inventoryItem { id tracked }
                  userErrors { field message }
                }
              }`,
            { id: inventoryItemId, input: { tracked: true } }
          );
          if (updateRes?.errors?.length) {
            lastError = updateRes.errors.map((e) => e?.message ?? String(e)).join(", ");
            if (attempt < maxAttempts) {
              await delayMs(800 * attempt);
              continue;
            }
            trackedUpdateFailed = true;
            errors.push({ inventoryItemId, message: lastError });
            break;
          }
          const updateData = (updateRes.data as { inventoryItemUpdate?: InventoryItemUpdatePayload })?.inventoryItemUpdate;
          const updateErrs = updateData?.userErrors ?? [];
          if (updateErrs.length > 0) {
            lastError =
              updateErrs.map((e) => e?.message).filter(Boolean).join(" / ") ||
              "在庫追跡の有効化に失敗しました";
            if (attempt < maxAttempts) {
              await delayMs(800 * attempt);
              continue;
            }
            // 最大試行回数を消費しても失敗 → needsActivate もスキップしてエラーを記録
            trackedUpdateFailed = true;
            errors.push({ inventoryItemId, message: lastError });
            break;
          } else {
            await delayMs(1000);
          }
        }

        if (!needsActivate) {
          succeeded = true;
          break;
        }

        const withQty =
          attempt === 1 && initialQty != null && Number.isFinite(Number(initialQty));
        const vars: Record<string, unknown> = {
          inventoryItemId,
          locationId: locationGid,
        };
        if (withQty) {
          const q = Math.floor(Number(initialQty));
          vars.available = q;
          vars.onHand = q;
        }

        const actRes = await graphql(
          admin,
          `#graphql
            mutation ActivateInventoryItem(
              $inventoryItemId: ID!
              $locationId: ID!
              $available: Int
              $onHand: Int
            ) {
              inventoryActivate(
                inventoryItemId: $inventoryItemId
                locationId: $locationId
                available: $available
                onHand: $onHand
              ) {
                inventoryLevel { id }
                userErrors { field message }
              }
            }`,
          vars
        );
        if (actRes?.errors?.length) {
          lastError = actRes.errors.map((e) => e?.message ?? String(e)).join(", ");
          if (attempt < maxAttempts) {
            await delayMs(800 * attempt);
            continue;
          }
          errors.push({ inventoryItemId, message: lastError ?? "在庫有効化に失敗しました" });
          break;
        }
        const payload = (actRes.data as { inventoryActivate?: InventoryActivatePayload })?.inventoryActivate;
        const userErrs = payload?.userErrors ?? [];
        if (userErrs.length > 0) {
          const errMsg =
            userErrs.map((e) => e?.message).filter(Boolean).join(" / ") ||
            "unknown";
          const alreadyActivated = /already|既に|activated|在庫レベル|already has/i.test(errMsg);
          if (alreadyActivated) {
            const check = await graphql(
              admin,
              `#graphql
                query CheckLevel($ids: [ID!]!, $locationId: ID!) {
                  nodes(ids: $ids) {
                    ... on InventoryItem {
                      id
                      inventoryLevel(locationId: $locationId) { id }
                    }
                  }
                }`,
              { ids: [inventoryItemId], locationId: locationGid }
            );
            if (check?.errors?.length) {
              // チェック失敗時はスキップ（既に有効化済みの可能性）
            }
            const nodes = (check.data as NodesQueryData)?.nodes ?? [];
            const node = nodes[0];
            if (node?.inventoryLevel?.id) {
              // level 確認済み。追加 verify は助言のみ（uncertain/lag で failed にしない）
              await delayMs(POST_ACTIVATE_SETTLE_MS);
              const verify = await verifyInventoryLevelsAtLocation(admin, locationId, [inventoryItemId]);
              if (!verify.ok) {
                console.warn(
                  `[ensureInventoryActivatedAtLocation] already-activated soft verify lag/uncertain for ${inventoryItemId}`,
                  { missing: verify.missingInventoryItemIds, uncertain: verify.uncertainInventoryItemIds }
                );
              }
              succeeded = true;
              break;
            }
          }
          lastError = errMsg;
          if (attempt < maxAttempts) {
            await delayMs(800 * attempt);
            continue;
          }
          errors.push({ inventoryItemId, message: lastError });
          break;
        }
        if (payload?.inventoryLevel?.id) {
          // activate 応答に level があれば成功扱い。再読取 lag は soft（setQuantities 側の 1 回再試行に委ねる）
          await delayMs(POST_ACTIVATE_SETTLE_MS);
          const verify = await verifyInventoryLevelsAtLocation(admin, locationId, [inventoryItemId]);
          if (!verify.ok) {
            console.warn(
              `[ensureInventoryActivatedAtLocation] post-activate soft verify lag/uncertain for ${inventoryItemId}`,
              { missing: verify.missingInventoryItemIds, uncertain: verify.uncertainInventoryItemIds }
            );
          }
          succeeded = true;
        } else {
          lastError = "inventoryLevel が返されませんでした";
          if (attempt < maxAttempts) {
            await delayMs(800 * attempt);
            continue;
          }
          errors.push({ inventoryItemId, message: lastError });
        }
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < maxAttempts) {
          await delayMs(800 * attempt);
          continue;
        }
        errors.push({ inventoryItemId, message: lastError });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
