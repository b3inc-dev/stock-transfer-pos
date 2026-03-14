// app/routes/webhooks.inventory_levels.update.tsx
// 在庫レベル更新Webhookハンドラー（管理画面での在庫変動検知）
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import shopify from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";
import type { AdminGraphQLRequestClient } from "../types";

// APIバージョン（shopify.server.tsと同じ値を使用）
const API_VERSION = "2026-01";

/** オンライン受注で inventory_levels/update が orders/updated より先に届いた場合に、OrderPendingLocation の登録を待つための待機・再検索 */
const PENDING_ORDER_WAIT_MS = 2500;
const PENDING_ORDER_MAX_RETRIES = 3; // 2.5秒×3回＝最大約7.5秒待機（履歴を意図通りにするため1回増）

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const action = async ({ request }: ActionFunctionArgs) => {
  // デバッグ: webhookが到達したかどうかを確認
  console.log(`[inventory_levels/update] Webhook endpoint called: method=${request.method}, url=${request.url}`);
  
  try {
    const { payload, shop, topic, session } = await authenticate.webhook(request);

    console.log(`[inventory_levels/update] Webhook received: shop=${shop}, topic=${topic}`);

    // topicの形式を正規化（大文字小文字、スラッシュ/アンダースコアの違いに対応）
    // INVENTORY_LEVELS_UPDATE → inventory_levels/update
    const topicStr = String(topic || "").toLowerCase();
    // アンダースコア区切りの形式をスラッシュ区切りに変換
    let normalizedTopic = topicStr;
    if (topicStr === "inventory_levels_update") {
      normalizedTopic = "inventory_levels/update";
    } else if (topicStr.includes("_")) {
      // 最後のアンダースコアをスラッシュに変換（例: inventory_levels_update → inventory_levels/update）
      normalizedTopic = topicStr.replace(/_([^_]+)$/, "/$1");
    }
    
    if (normalizedTopic !== "inventory_levels/update") {
      console.log(`[inventory_levels/update] Invalid topic: ${topic} (normalized: ${normalizedTopic})`);
      return new Response("Invalid topic", { status: 400 });
    }

    // Webhookのペイロードから在庫情報を取得
    const inventoryLevel = payload as {
      inventory_item_id?: string;
      location_id?: string;
      available?: number;
      updated_at?: string;
      inventory_adjustment_group_id?: string; // 在庫調整グループID（存在する場合）
    };

    if (!inventoryLevel.inventory_item_id || !inventoryLevel.location_id) {
      console.error("Missing required fields in inventory_levels/update webhook:", inventoryLevel);
      return new Response("Missing required fields", { status: 400 });
    }

    // inventory_adjustment_group_idが含まれている場合はログ出力
    if (inventoryLevel.inventory_adjustment_group_id) {
      console.log(`[inventory_levels/update] Found inventory_adjustment_group_id: ${inventoryLevel.inventory_adjustment_group_id}`);
    }

    // 元の形式を保持（データベース保存用）
    const inventoryItemIdRaw = String(inventoryLevel.inventory_item_id);
    const locationIdRaw = String(inventoryLevel.location_id);
    const available = Number(inventoryLevel.available ?? 0);
    const updatedAt = inventoryLevel.updated_at ? new Date(inventoryLevel.updated_at) : new Date();
    
    // locationIdをGID形式に変換（数値形式の場合はGID形式に変換、GraphQLクエリ用）
    const locationId = locationIdRaw.startsWith("gid://") 
      ? locationIdRaw 
      : `gid://shopify/Location/${locationIdRaw}`;
    
    // inventoryItemIdもGID形式に変換（数値形式の場合はGID形式に変換、GraphQLクエリ用）
    const inventoryItemId = inventoryItemIdRaw.startsWith("gid://")
      ? inventoryItemIdRaw
      : `gid://shopify/InventoryItem/${inventoryItemIdRaw}`;

    // セッションが無くても最小限の記録は行う（インストール直後・再デプロイ直後に管理画面を開かなくても履歴に残す）
    let shopTimezone = "UTC";
    let locationName = locationIdRaw;
    let sku = "";
    let variantId: string | null = null;
    let activity: "inbound_transfer" | "outbound_transfer" | "loss_entry" | "inventory_count" | "admin_webhook" = "admin_webhook";
    let adjustmentGroupId: string | null = inventoryLevel.inventory_adjustment_group_id || null;
    let sourceId: string | null = null;

    // adminクライアント: if(session) の外で宣言し、else if(adjustmentGroupId && session) でも参照できるようにする
    let admin: AdminGraphQLRequestClient | null = null;

    if (session) {
      // adminクライアントを作成（ロケーション名・SKU・種別判定に使用）
      if (shopify?.clients?.Graphql) {
        admin = shopify.clients.Graphql({ session });
      } else {
        console.log(`[inventory_levels/update] shopify.clients not available, creating GraphQL client from session`);
        const shopDomain = session.shop;
        const accessToken = session.accessToken;
        admin = {
          request: async (options: { data: string; variables?: Record<string, unknown> }) => {
            const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
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
            return response;
          },
        };
      }
      if (admin) admin = withGraphQLRetry(admin);

      // タイムゾーン取得（失敗時は UTC にフォールバック）
      try {
        const shopTimezoneResp = await admin!.request({
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
        if (shopTimezoneData?.errors?.length) {
          console.warn("[inventory_levels/update] GetShopTimezone GraphQL errors:", shopTimezoneData.errors);
        } else {
          shopTimezone = shopTimezoneData?.data?.shop?.ianaTimezone || "UTC";
        }
      } catch (tzErr) {
        console.warn(`[inventory_levels/update] タイムゾーン取得失敗、UTC にフォールバック:`, tzErr);
      }

      // ロケーション名を取得（GraphQL）、失敗時は locationIdRaw をフォールバックとして使用
      try {
        const locationResp = await admin!.request({
          data: `
            #graphql
            query GetLocation($id: ID!) {
              location(id: $id) {
                id
                name
              }
            }
          `,
          variables: { id: locationId },
        });
        const locationData = await locationResp.json();
        if (locationData?.errors?.length) {
          console.warn("[inventory_levels/update] GetLocation GraphQL errors:", locationData.errors);
        } else {
          locationName = locationData?.data?.location?.name || locationIdRaw;
        }
      } catch (locErr) {
        console.warn(`[inventory_levels/update] ロケーション名取得失敗、ID をフォールバックとして使用:`, locErr);
      }

      // SKUを取得（InventoryItemから）、失敗しても処理継続
      try {
        const itemResp = await admin!.request({
          data: `
            #graphql
            query GetInventoryItem($id: ID!) {
              inventoryItem(id: $id) {
                id
                variant {
                  id
                  sku
                }
              }
            }
          `,
          variables: { id: inventoryItemId },
        });
        const itemData = await itemResp.json();
        if (itemData?.errors?.length) {
          console.warn("[inventory_levels/update] GetInventoryItem GraphQL errors:", itemData.errors);
        } else {
          sku = itemData?.data?.inventoryItem?.variant?.sku || "";
          variantId = itemData?.data?.inventoryItem?.variant?.id || null;
        }
      } catch (itemErr) {
        console.warn(`[inventory_levels/update] SKU・variantId 取得失敗、空値を使用:`, itemErr);
      }

      // 入庫・出庫・ロス・棚卸・仕入をすべて「同じ処理」にするため、Webhook では種別を判定しない。
      // 常に admin_webhook（管理）で保存し、POS/アプリの api/log-inventory-change が正しい activity で上書きする。
      // （以前は adjustment_group の referenceUri からロス等を判定していたが、ロスだけ記録されて他が「管理」のままになる原因になり得たため廃止。）
      activity = "admin_webhook";
      sourceId = null;
      if (adjustmentGroupId) {
        console.log(`[inventory_levels/update] adjustment_group_id present but not used for activity; recording as admin_webhook. API will overwrite.`);
      } else {
        console.log(`[inventory_levels/update] No adjustment_group_id. Recording as admin_webhook; api/log-inventory-change will overwrite to correct activity.`);
      }
      console.log(`[inventory_levels/update] Final activity: admin_webhook (API overwrites for all: loss, inbound, outbound, stocktake, purchase).`);
    } else {
      console.log(`[inventory_levels/update] No session; saving minimal log (no GraphQL). 管理画面でアプリを開くとロケーション名・SKUが取得されます。`);
    }

    // 日付を取得（YYYY-MM-DD形式）
    const date = getDateInShopTimezone(updatedAt, shopTimezone);

    // 直前の在庫値を取得（delta計算用）
    let prevAvailable: number | null = null;
    let delta: number | null = null;
    let idempotencyKey = "";
    let existingLog = null;

    try {
      if (db && typeof db.inventoryChangeLog !== "undefined") {
        // 直前ログ検索は「数値IDのみ」だと order_sales/refund（GID形式で保存）を拾えず delta が誤計算になるため、両形式を候補にする
        const prevItemCandidates = [inventoryItemIdRaw, `gid://shopify/InventoryItem/${inventoryItemIdRaw}`];
        const prevLocCandidates = [locationIdRaw, `gid://shopify/Location/${locationIdRaw}`];
        const prevLog = await db.inventoryChangeLog.findFirst({
          where: {
            shop,
            inventoryItemId: { in: prevItemCandidates },
            locationId: { in: prevLocCandidates },
          },
          orderBy: {
            timestamp: "desc",
          },
        });

        prevAvailable = prevLog?.quantityAfter ?? null;

        // 強固な delta 算出: 直前ログの quantityAfter が null でも、同一商品・ロケーションで
        // quantityAfter が null でない直近1件を遡って取得し、変動数「-」を減らす
        if (prevAvailable === null && db && typeof db.inventoryChangeLog !== "undefined") {
          const prevLogWithQty = await db.inventoryChangeLog.findFirst({
            where: {
              shop,
              inventoryItemId: { in: prevItemCandidates },
              locationId: { in: prevLocCandidates },
              quantityAfter: { not: null },
            },
            orderBy: { timestamp: "desc" },
          });
          if (prevLogWithQty?.quantityAfter != null) {
            prevAvailable = prevLogWithQty.quantityAfter;
            console.log(`[inventory_levels/update] Using previous log with quantityAfter for delta: id=${prevLogWithQty.id}, quantityAfter=${prevAvailable}`);
          }
        }
        
        // deltaの計算: 直前のログ（または遡ったログ）があればそれから計算、なければinventory_adjustment_group_idから取得を試みる
        if (prevAvailable !== null) {
          // 直前のログがある場合: 通常の計算
          delta = available - prevAvailable;
        } else if (adjustmentGroupId && session && admin) {
          // 直前のログがない場合: inventory_adjustment_group_idがあればそこからdeltaを取得
          // admin は if(session) ブロックで初期化済み（null でないことをガード済み）
          try {
            console.log(`[inventory_levels/update] No previous log found, fetching delta from InventoryAdjustmentGroup: ${adjustmentGroupId}`);
            const adjustmentGroupIdGid = adjustmentGroupId.startsWith("gid://") ? adjustmentGroupId : `gid://shopify/InventoryAdjustmentGroup/${adjustmentGroupId}`;
            const adjustmentGroupResp = await admin.request({
              data: `
                #graphql
                query GetInventoryAdjustmentGroup($id: ID!, $itemId: ID!, $locationId: ID!) {
                  node(id: $id) {
                    ... on InventoryAdjustmentGroup {
                      id
                      changes(inventoryItemIds: [$itemId], locationIds: [$locationId]) {
                        deltaQuantity
                        inventoryItem {
                          id
                        }
                        location {
                          id
                        }
                      }
                    }
                  }
                }
              `,
              variables: { 
                id: adjustmentGroupIdGid,
                itemId: inventoryItemId,
                locationId: locationId,
              },
            });
            const adjustmentGroupData = await adjustmentGroupResp.json();
            const node = adjustmentGroupData?.data?.node;
            const matchingChange = node?.changes?.find((change: { delta?: unknown; [key: string]: unknown }) => 
              change?.inventoryItem?.id === inventoryItemId && change?.location?.id === locationId
            );
            if (matchingChange?.deltaQuantity !== undefined && matchingChange?.deltaQuantity !== null) {
              delta = matchingChange.deltaQuantity;
              console.log(`[inventory_levels/update] Calculated delta from InventoryAdjustmentGroup: delta=${delta}`);
            } else {
              delta = null;
              console.log(`[inventory_levels/update] No matching change found in InventoryAdjustmentGroup, delta remains null`);
            }
          } catch (error) {
            console.error("[inventory_levels/update] Error fetching InventoryAdjustmentGroup:", error);
            delta = null;
          }
        } else {
          // 直前のログもなく、inventory_adjustment_group_idもない場合
          delta = null;
        }

        // idempotencyKeyを生成（重複防止、元の形式を使用）
        // updatedAtは秒単位に丸めて使用（ミリ秒の違いで重複チェックが失敗するのを防ぐ）
        // availableは含めない（同じ操作でもavailableが異なる可能性があるため）
        const updatedAtRounded = new Date(Math.floor(updatedAt.getTime() / 1000) * 1000);
        idempotencyKey = `${shop}:${inventoryItemIdRaw}:${locationIdRaw}:${updatedAtRounded.toISOString()}`;

        // 既に同じidempotencyKeyのログが存在する場合はスキップ（二重登録防止）
        existingLog = await db.inventoryChangeLog.findUnique({
          where: {
            shop_idempotencyKey: {
              shop,
              idempotencyKey,
            },
          },
        });

        if (existingLog) {
          console.log(`Skipping duplicate webhook: ${idempotencyKey}`);
          return new Response("OK", { status: 200 });
        }
      } else {
        console.warn("InventoryChangeLog model not found in Prisma client. Please restart the dev server.");
        return new Response("OK", { status: 200 }); // Webhookは成功として返す（ログは保存されない）
      }
    } catch (error) {
      console.error("Error checking previous log:", error);
      // エラーが発生しても続行（deltaはnullのまま）
    }

    // 変動がない（delta が 0）場合はログを保存しない（「0」の行が履歴に並ばないようにする）
    if (delta === 0) {
      console.log(`[inventory_levels/update] Skipping log: no change (delta=0), item=${inventoryItemIdRaw}, location=${locationIdRaw}, quantityAfter=${available}`);
      return new Response("OK", { status: 200 });
    }

    // 重複チェック：同一イベントの重複送信のみスキップする（別イベントの行を上書きしない）
    // 既存行の quantityAfter が今回の available と一致する、または null（未確定）のときだけ「同一イベント」とみなし、
    // その行の quantityAfter を更新して return。一致しない場合は別イベントなので既存行は触らず新規作成へ進む。
    if (db && typeof db.inventoryChangeLog !== "undefined") {
      const duplicateCheckThreshold = new Date(updatedAt.getTime() - 5 * 1000); // 5秒前
      const duplicateCheckTo = new Date(updatedAt.getTime() + 5 * 1000); // 5秒後
      const duplicateAdminLog = await db.inventoryChangeLog.findFirst({
        where: {
          shop,
          inventoryItemId: inventoryItemIdRaw,
          locationId: locationIdRaw,
          activity: "admin_webhook",
          timestamp: { gte: duplicateCheckThreshold, lte: duplicateCheckTo },
        },
      });
      if (duplicateAdminLog) {
        const existingQty = duplicateAdminLog.quantityAfter ?? null;
        const isSameEvent = existingQty === available || existingQty === null;
        if (isSameEvent) {
          console.log(
            `[inventory_levels/update] Skipping duplicate admin_webhook log (same event): existing id=${duplicateAdminLog.id}, quantityAfter=${duplicateAdminLog.quantityAfter}`
          );
          if (duplicateAdminLog.quantityAfter !== available) {
            await db.inventoryChangeLog.update({
              where: { id: duplicateAdminLog.id },
              data: { quantityAfter: available },
            });
            console.log(`[inventory_levels/update] Updated existing admin_webhook log quantityAfter: ${duplicateAdminLog.quantityAfter} -> ${available}`);
          }
          return new Response("OK", { status: 200 });
        }
        console.log(
          `[inventory_levels/update] Existing admin_webhook in window but different event (quantityAfter ${existingQty} !== available ${available}), will create new row`
        );
      }
    }

    // 同一の在庫変動がすでに別の経路で記録されていたら webhook では「管理」行を新規作成せず、
    // 既存行の quantityAfter を最新値で更新する。
    // （POS/アプリの api/log-inventory-change、売上 orders.updated、返品 refunds.create で正しい種別が付いている）
    // そうしないと二重に「管理」で保存され、売上・返品・ロス等が「管理」で上書きされたように見える。
    if (db && typeof db.inventoryChangeLog !== "undefined") {
      const knownActivities = [
        "loss_entry",
        "purchase_entry",
        "purchase_cancel", // 仕入キャンセル（api/log-inventory-change で記録）
        "inbound_transfer",
        "outbound_transfer",
        "inventory_count",
        "order_sales",
        "refund", // 売上・返品（orders.updated / refunds.create で記録済み）
        "order_cancel", // キャンセル戻り（orders.updated で記録済み）
      ];
      // タイムウィンドウを拡大（orders/updatedやrefunds/createとinventory_levels/updateのタイムスタンプのずれを考慮）
      // 過去30分前から未来5分後まで検索（orders/updatedが先に来る場合も考慮）
      const searchFrom = new Date(updatedAt.getTime() - 30 * 60 * 1000); // 30分前
      const searchTo = new Date(updatedAt.getTime() + 5 * 60 * 1000); // 5分後

      // 直近で同一商品・ロケーションの既知アクティビティが記録されていれば、
      // それをこの webhook で上書き（quantityAfter のみ更新）し、新しい「管理」行は作らない。
      //
      // ⚠ 重要:
      // - 売上（orders.updated）や返品（refunds.create）では inventoryItemId / locationId を
      //   「GID 形式（gid://shopify/...）」で保存している。
      // - inventory_levels/update Webhook では数値ID（raw）で受け取っており、そのまま保存している。
      // そのため、ここでは **両方の形式** を候補として検索しないと、同じ在庫変動でも
      // 「order_sales」と「admin_webhook」が別々の行として二重に記録されてしまう。
      const inventoryItemIdCandidates = [
        inventoryItemIdRaw,
        `gid://shopify/InventoryItem/${inventoryItemIdRaw}`,
      ];
      const locationIdCandidates = [
        locationIdRaw,
        `gid://shopify/Location/${locationIdRaw}`,
      ];

      // 過去30分前から未来5分後までの範囲で検索
      // （orders/updatedが先に来て、その後にinventory_levels/updateが来る場合も考慮）
      let recentNonAdminLog = await db.inventoryChangeLog.findFirst({
        where: {
          shop,
          inventoryItemId: { in: inventoryItemIdCandidates },
          locationId: { in: locationIdCandidates },
          activity: { in: knownActivities },
          timestamp: { gte: searchFrom, lte: searchTo },
        },
        orderBy: { timestamp: "desc" },
      });
      
      if (recentNonAdminLog) {
        console.log(
          `[inventory_levels/update] Found existing log: id=${recentNonAdminLog.id}, activity=${recentNonAdminLog.activity}, timestamp=${recentNonAdminLog.timestamp}`
        );
      }

      // デバッグログ：検索結果を出力
      if (!recentNonAdminLog) {
        // より詳細なデバッグ：実際に存在するログを確認
        const allRecentLogs = await db.inventoryChangeLog.findMany({
          where: {
            shop,
            inventoryItemId: { in: inventoryItemIdCandidates },
            locationId: { in: locationIdCandidates },
            timestamp: { gte: searchFrom, lte: searchTo },
          },
          orderBy: { timestamp: "desc" },
          take: 10,
        });
        console.log(
          `[inventory_levels/update] No recent non-admin log found. Search criteria: shop=${shop}, inventoryItemIds=[${inventoryItemIdCandidates.join(", ")}], locationIds=[${locationIdCandidates.join(", ")}], activities=[${knownActivities.join(", ")}], timestamp between ${searchFrom.toISOString()} and ${searchTo.toISOString()}`
        );
        if (allRecentLogs.length > 0) {
          console.log(
            `[inventory_levels/update] Found ${allRecentLogs.length} recent logs (but none match activity filter):`,
            allRecentLogs.map((log: { id?: string; delta?: number | null; [key: string]: unknown }) => ({
              id: log.id,
              activity: log.activity,
              timestamp: log.timestamp,
              inventoryItemId: log.inventoryItemId,
              locationId: log.locationId,
            }))
          );
        } else {
          console.log(`[inventory_levels/update] No logs found at all for this item/location combination.`);
        }
      }

      if (recentNonAdminLog) {
        // 既存ログの変動後数量と今回の available が同じ＝同一イベントの追報なので quantityAfter のみ更新して終了。
        // 既存ログの quantityAfter が null＝API（api/log-inventory-change）が先に作成した行で数量未確定。
        //   → 同一イベントの追報とみなし、quantityAfter を available で更新するだけにして新規「管理」行は作らない（二重記録防止）。
        // 異なる（両方とも数値で不一致）＝別イベント（例: 仕入の直後に FLOW で 0 に戻した）なので、新規「管理」行を作成する。
        const existingQty = recentNonAdminLog.quantityAfter ?? null;
        if (existingQty === available) {
          try {
            console.log(
              `[inventory_levels/update] Updating existing log from webhook: id=${recentNonAdminLog.id}, activity=${recentNonAdminLog.activity}, quantityAfter=${recentNonAdminLog.quantityAfter} -> ${available}`
            );
            await db.inventoryChangeLog.update({
              where: { id: recentNonAdminLog.id },
              data: { quantityAfter: available },
            });
          } catch (e: unknown) {
            console.error(
              "[inventory_levels/update] Failed to update existing log from webhook:",
              e instanceof Error ? e.message : String(e)
            );
          }
          return new Response("OK", { status: 200 });
        }
        if (existingQty === null) {
          // 大量入庫時: API が inbound_transfer で quantityAfter=null を作成→Webhook が後から届くパターン。新規 admin_webhook を作らず既存行を確定させる。
          // POS 由来で API が delta を入れられていない場合に備え、既存行の delta が null なら「直前の確定数量」から算出して補完する。
          let updateData: { quantityAfter: number; delta?: number } = { quantityAfter: available };
          if (recentNonAdminLog.delta == null && db && typeof db.inventoryChangeLog !== "undefined") {
            const prevWithQty = await db.inventoryChangeLog.findFirst({
              where: {
                shop,
                inventoryItemId: { in: inventoryItemIdCandidates },
                locationId: { in: locationIdCandidates },
                quantityAfter: { not: null },
                timestamp: { lt: recentNonAdminLog.timestamp },
              },
              orderBy: { timestamp: "desc" },
            });
            if (prevWithQty?.quantityAfter != null) {
              const computedDelta = available - prevWithQty.quantityAfter;
              updateData.delta = computedDelta;
              console.log(
                `[inventory_levels/update] Complementing delta for same-event update: id=${recentNonAdminLog.id}, prevAvailable=${prevWithQty.quantityAfter}, delta=${computedDelta}`
              );
            }
          }
          try {
            console.log(
              `[inventory_levels/update] Existing log quantityAfter is null; updating to available (same event): id=${recentNonAdminLog.id}, activity=${recentNonAdminLog.activity}, quantityAfter -> ${available}`
            );
            await db.inventoryChangeLog.update({
              where: { id: recentNonAdminLog.id },
              data: updateData,
            });
          } catch (e: unknown) {
            console.error(
              "[inventory_levels/update] Failed to update existing log (quantityAfter null):",
              e instanceof Error ? e.message : String(e)
            );
          }
          return new Response("OK", { status: 200 });
        }
        console.log(
          `[inventory_levels/update] Existing log quantityAfter (${existingQty}) !== available (${available}); treating as new event, will create admin_webhook row`
        );
      }

      // 直近が admin_webhook のみの場合: 同一変動の2本目（販売可能→手持ちの2回更新など）で二重にならないよう、
      // 時間が非常に近い admin_webhook で quantityAfter が一致または null ならその行を更新して新規を作らない
      if (!recentNonAdminLog) {
        const sameEventWindowFrom = new Date(updatedAt.getTime() - 2 * 60 * 1000); // 2分前
        const sameEventWindowTo = new Date(updatedAt.getTime() + 1 * 60 * 1000);   // 1分後
        const recentAdminOnly = await db.inventoryChangeLog.findFirst({
          where: {
            shop,
            inventoryItemId: { in: inventoryItemIdCandidates },
            locationId: { in: locationIdCandidates },
            activity: "admin_webhook",
            timestamp: { gte: sameEventWindowFrom, lte: sameEventWindowTo },
          },
          orderBy: { timestamp: "desc" },
        });
        if (recentAdminOnly && (recentAdminOnly.quantityAfter === available || recentAdminOnly.quantityAfter == null)) {
          let updateSameEvent: { quantityAfter: number; delta?: number } = { quantityAfter: available };
          if (recentAdminOnly.delta == null) {
            const prevForDelta = await db.inventoryChangeLog.findFirst({
              where: {
                shop,
                inventoryItemId: { in: inventoryItemIdCandidates },
                locationId: { in: locationIdCandidates },
                quantityAfter: { not: null },
                timestamp: { lt: recentAdminOnly.timestamp },
              },
              orderBy: { timestamp: "desc" },
            });
            if (prevForDelta?.quantityAfter != null) {
              updateSameEvent.delta = available - prevForDelta.quantityAfter;
            }
          }
          await db.inventoryChangeLog.update({
            where: { id: recentAdminOnly.id },
            data: updateSameEvent,
          });
          console.log(
            `[inventory_levels/update] Updated recent admin_webhook (same event, avoid duplicate): id=${recentAdminOnly.id}, quantityAfter -> ${available}`
          );
          return new Response("OK", { status: 200 });
        }
      }
    }

    // 受注直後は orders/updated でロケーションが取れず OrderPendingLocation に登録されている場合がある。
    // 同一商品・時刻が近い保留注文があれば、この変動は「売上」として記録する。短時間複数注文時は「変動前在庫 === available + 売上数」で正しい注文にマッチする。
    // 同一注文で2ロケーション出荷に対応するため、locationId でフィルタする（空文字は従来データ用）。
    // 返品は refunds/create で RefundPendingLocation に登録。在庫増（delta>0）時にマッチすれば「返品」として記録。
    let pendingOrder: { orderId: string; quantity: number; locationId: string } | null = null;
    let pendingRefund: { refundId: string; orderId: string; quantity: number; locationId: string } | null = null;
    if (db && typeof db.orderPendingLocation !== "undefined") {
      const pendingFrom = new Date(updatedAt.getTime() - 5 * 60 * 1000);
      const pendingTo = new Date(updatedAt.getTime() + 2 * 60 * 1000);
      // 空文字 "" は .filter(Boolean) で除かれるため使わない。ロケーション不明で登録された OrderPendingLocation（locationId=""）をマッチさせるため "" を必ず含める
      const orderLocCands = [locationIdRaw, `gid://shopify/Location/${locationIdRaw}`, ""];
      const allPendings = await db.orderPendingLocation.findMany({
        where: {
          shop,
          inventoryItemId: inventoryItemIdRaw,
          locationId: { in: orderLocCands },
          orderCreatedAt: { gte: pendingFrom, lte: pendingTo },
        },
        orderBy: { orderCreatedAt: "desc" },
      });
      const prevForMatch = prevAvailable ?? null;
      const matched =
        prevForMatch != null
          ? allPendings.find((p: { quantity: number }) => {
              const qty = Math.max(1, Number(p.quantity) || 1);
              return available + qty === prevForMatch;
            })
          : allPendings[0] ?? null;
      const pending = matched ?? allPendings[0] ?? null;
      if (pending) {
        const qty = Math.max(1, Number(pending.quantity) || 1);
        pendingOrder = { orderId: pending.orderId, quantity: qty, locationId: pending.locationId ?? "" };
        console.log(
          `[inventory_levels/update] Matched OrderPendingLocation: orderId=${pending.orderId}, quantity=${qty}, locationId=${pending.locationId ?? ""}, prevAvailable=${prevForMatch ?? "n/a"}, will save as order_sales`
        );
      }
    }

    // 在庫増（delta>0）の場合、RefundPendingLocation を検索（返品として記録）。短時間複数返品時は「変動前在庫 === available - 返品数」で正しい返品にマッチする。
    // 空文字 "" を検索に含める（refunds/create で location_id が空になるエッジケースに備え、OrderPendingLocation と同様に .filter(Boolean) は使わない）
    if ((delta === null || (delta !== null && delta > 0)) && !pendingOrder && db && typeof db.refundPendingLocation !== "undefined") {
      const refundFrom = new Date(updatedAt.getTime() - 5 * 60 * 1000);
      const refundTo = new Date(updatedAt.getTime() + 2 * 60 * 1000);
      const locCands = [locationIdRaw, locationIdRaw.replace(/^gid:\/\/shopify\/Location\//, ""), `gid://shopify/Location/${locationIdRaw}`, ""];
      const allRefundPendings = await db.refundPendingLocation.findMany({
        where: {
          shop,
          inventoryItemId: inventoryItemIdRaw,
          locationId: { in: locCands },
          refundCreatedAt: { gte: refundFrom, lte: refundTo },
        },
        orderBy: { refundCreatedAt: "desc" },
      });
      const prevForRefund = prevAvailable ?? null;
      const matchedRefund =
        prevForRefund != null
          ? allRefundPendings.find((p: { quantity: number }) => {
              const qty = Math.max(1, Number(p.quantity) || 1);
              return prevForRefund === available - qty;
            })
          : allRefundPendings[0] ?? null;
      const pendingRef = matchedRefund ?? allRefundPendings[0] ?? null;
      if (pendingRef) {
        const qty = Math.max(1, Number(pendingRef.quantity) || 1);
        pendingRefund = { refundId: pendingRef.refundId, orderId: pendingRef.orderId, quantity: qty, locationId: pendingRef.locationId ?? "" };
        console.log(`[inventory_levels/update] Matched RefundPendingLocation: refundId=${pendingRef.refundId}, orderId=${pendingRef.orderId}, quantity=${qty}, locationId=${pendingRef.locationId ?? ""}, prevAvailable=${prevForRefund ?? "n/a"}, will save as refund`);
      }
    }

    let finalActivity = pendingOrder ? "order_sales" : pendingRefund ? "refund" : activity;
    let finalSourceId = pendingOrder ? `order_${pendingOrder.orderId}` : pendingRefund ? `order_${pendingRefund.orderId}` : sourceId;
    let finalNote = pendingOrder ? `注文: #${pendingOrder.orderId}` : pendingRefund ? `返品: 注文 #${pendingRefund.orderId}` : null;
    // 売上はオーダー数量を変動数に反映（-数量）。返品は+数量。POS・オンライン共通で履歴に変動数を表示するため
    let finalDelta: number | null = pendingOrder ? -pendingOrder.quantity : pendingRefund ? pendingRefund.quantity : delta;

    // 保存直前に OrderPendingLocation / RefundPendingLocation を再チェック（レース対策）
    // 処理開始時には無くても、その間に orders/updated や refunds/create が登録している場合がある
    if (!pendingOrder && !pendingRefund && finalActivity === "admin_webhook" && db && typeof db.orderPendingLocation !== "undefined") {
      const pendingFrom = new Date(updatedAt.getTime() - 5 * 60 * 1000);
      const pendingTo = new Date(updatedAt.getTime() + 2 * 60 * 1000);
      const orderLocCandsAgain = [locationIdRaw, `gid://shopify/Location/${locationIdRaw}`, ""];
      const allAgain = await db.orderPendingLocation.findMany({
        where: { shop, inventoryItemId: inventoryItemIdRaw, locationId: { in: orderLocCandsAgain }, orderCreatedAt: { gte: pendingFrom, lte: pendingTo } },
        orderBy: { orderCreatedAt: "desc" },
      });
      const prevForAgain = prevAvailable ?? null;
      const matchedAgain =
        prevForAgain != null
          ? allAgain.find((p: { quantity: number }) => available + Math.max(1, Number(p.quantity) || 1) === prevForAgain)
          : allAgain[0] ?? null;
      const pendingAgain = matchedAgain ?? allAgain[0] ?? null;
      if (pendingAgain) {
        const qty = Math.max(1, Number(pendingAgain.quantity) || 1);
        pendingOrder = { orderId: pendingAgain.orderId, quantity: qty, locationId: pendingAgain.locationId ?? "" };
        finalActivity = "order_sales";
        finalSourceId = `order_${pendingOrder.orderId}`;
        finalNote = `注文: #${pendingOrder.orderId}`;
        finalDelta = -pendingOrder.quantity;
        console.log(`[inventory_levels/update] Before create: matched OrderPendingLocation orderId=${pendingOrder.orderId}, quantity=${qty}, will save as order_sales`);
      }
    }
    if (!pendingOrder && !pendingRefund && finalActivity === "admin_webhook" && (delta === null || (delta !== null && delta > 0)) && db && typeof db.refundPendingLocation !== "undefined") {
      const refundFrom = new Date(updatedAt.getTime() - 5 * 60 * 1000);
      const refundTo = new Date(updatedAt.getTime() + 2 * 60 * 1000);
      const locCands = [locationIdRaw, locationIdRaw.replace(/^gid:\/\/shopify\/Location\//, ""), `gid://shopify/Location/${locationIdRaw}`, ""];
      const allRefAgain = await db.refundPendingLocation.findMany({
        where: { shop, inventoryItemId: inventoryItemIdRaw, locationId: { in: locCands }, refundCreatedAt: { gte: refundFrom, lte: refundTo } },
        orderBy: { refundCreatedAt: "desc" },
      });
      const prevForRefAgain = prevAvailable ?? null;
      const matchedRefAgain =
        prevForRefAgain != null
          ? allRefAgain.find((p: { quantity: number }) => prevForRefAgain === available - Math.max(1, Number(p.quantity) || 1))
          : allRefAgain[0] ?? null;
      const pendingRefAgain = matchedRefAgain ?? allRefAgain[0] ?? null;
      if (pendingRefAgain) {
        const qty = Math.max(1, Number(pendingRefAgain.quantity) || 1);
        pendingRefund = { refundId: pendingRefAgain.refundId, orderId: pendingRefAgain.orderId, quantity: qty, locationId: pendingRefAgain.locationId ?? "" };
        finalActivity = "refund";
        finalSourceId = `order_${pendingRefund.orderId}`;
        finalNote = `返品: 注文 #${pendingRefund.orderId}`;
        finalDelta = pendingRefund.quantity;
        console.log(`[inventory_levels/update] Before create: matched RefundPendingLocation refundId=${pendingRefund.refundId}, will save as refund`);
      }
    }

    // まだ「管理」で保存しようとしている場合、orders/updated または refunds/create の登録を待って再検索する（完全反映のため）
    // Shopify は inventory_levels/update を先に送ることがあり、その時点では OrderPendingLocation / RefundPendingLocation がまだ無いため待機＋最大2回再検索
    if (!pendingOrder && !pendingRefund && finalActivity === "admin_webhook" && db) {
      if (typeof db.orderPendingLocation !== "undefined") {
      const pendingFrom = new Date(updatedAt.getTime() - 5 * 60 * 1000);
      const pendingTo = new Date(updatedAt.getTime() + 2 * 60 * 1000);
      for (let retry = 0; retry < PENDING_ORDER_MAX_RETRIES; retry++) {
        await sleep(PENDING_ORDER_WAIT_MS);
        const orderLocCandsRetry = [locationIdRaw, `gid://shopify/Location/${locationIdRaw}`, ""];
        const allRetry = await db.orderPendingLocation.findMany({
          where: { shop, inventoryItemId: inventoryItemIdRaw, locationId: { in: orderLocCandsRetry }, orderCreatedAt: { gte: pendingFrom, lte: pendingTo } },
          orderBy: { orderCreatedAt: "desc" },
        });
        const prevForRetry = prevAvailable ?? null;
        const matchedRetry =
          prevForRetry != null
            ? allRetry.find((p: { quantity: number }) => available + Math.max(1, Number(p.quantity) || 1) === prevForRetry)
            : allRetry[0] ?? null;
        const pendingRetry = matchedRetry ?? allRetry[0] ?? null;
        if (pendingRetry) {
          const qty = Math.max(1, Number(pendingRetry.quantity) || 1);
          pendingOrder = { orderId: pendingRetry.orderId, quantity: qty, locationId: pendingRetry.locationId ?? "" };
          finalActivity = "order_sales";
          finalSourceId = `order_${pendingOrder.orderId}`;
          finalNote = `注文: #${pendingOrder.orderId}`;
          finalDelta = -pendingOrder.quantity;
          console.log(`[inventory_levels/update] After wait (retry ${retry + 1}): matched OrderPendingLocation orderId=${pendingOrder.orderId}, quantity=${qty}, will save as order_sales`);
          break;
        }
      }
      }
      if (!pendingOrder && !pendingRefund && finalActivity === "admin_webhook" && (delta === null || (delta !== null && delta > 0)) && typeof db.refundPendingLocation !== "undefined") {
        for (let retry = 0; retry < PENDING_ORDER_MAX_RETRIES; retry++) {
          await sleep(PENDING_ORDER_WAIT_MS);
          const refundFrom = new Date(updatedAt.getTime() - 5 * 60 * 1000);
          const refundTo = new Date(updatedAt.getTime() + 2 * 60 * 1000);
          const locCands = [locationIdRaw, locationIdRaw.replace(/^gid:\/\/shopify\/Location\//, ""), `gid://shopify/Location/${locationIdRaw}`, ""];
          const allRefRetry = await db.refundPendingLocation.findMany({
            where: { shop, inventoryItemId: inventoryItemIdRaw, locationId: { in: locCands }, refundCreatedAt: { gte: refundFrom, lte: refundTo } },
            orderBy: { refundCreatedAt: "desc" },
          });
          const prevForRefRetry = prevAvailable ?? null;
          const matchedRefRetry =
            prevForRefRetry != null
              ? allRefRetry.find((p: { quantity: number }) => prevForRefRetry === available - Math.max(1, Number(p.quantity) || 1))
              : allRefRetry[0] ?? null;
          const pendingRefRetry = matchedRefRetry ?? allRefRetry[0] ?? null;
          if (pendingRefRetry) {
            const qty = Math.max(1, Number(pendingRefRetry.quantity) || 1);
            pendingRefund = { refundId: pendingRefRetry.refundId, orderId: pendingRefRetry.orderId, quantity: qty, locationId: pendingRefRetry.locationId ?? "" };
            finalActivity = "refund";
            finalSourceId = `order_${pendingRefund.orderId}`;
            finalNote = `返品: 注文 #${pendingRefund.orderId}`;
            finalDelta = pendingRefund.quantity;
            console.log(`[inventory_levels/update] After wait (retry ${retry + 1}): matched RefundPendingLocation refundId=${pendingRefund.refundId}, will save as refund`);
            break;
          }
        }
      }
    }

    // OrderPendingLocation にマッチした場合、既存の admin_webhook 行を order_sales に更新して新規行を作らない（20:11/20:14 型の二重「管理」防止）
    if (pendingOrder && db && typeof db.inventoryChangeLog !== "undefined") {
      const searchFrom = new Date(updatedAt.getTime() - 30 * 60 * 1000);
      const searchTo = new Date(updatedAt.getTime() + 5 * 60 * 1000);
      const expectedPrevQty = available + pendingOrder.quantity;
      let existingAdmin = await db.inventoryChangeLog.findFirst({
        where: {
          shop,
          inventoryItemId: inventoryItemIdRaw,
          locationId: locationIdRaw,
          activity: "admin_webhook",
          quantityAfter: expectedPrevQty,
          timestamp: { gte: searchFrom, lte: searchTo },
        },
        orderBy: { timestamp: "desc" },
      });
      // 先に届いた Webhook が「売上後」の値で admin_webhook 保存している場合（quantityAfter=available）。その行を order_sales に更新して二重行を防ぐ
      if (!existingAdmin && available !== expectedPrevQty) {
        existingAdmin = await db.inventoryChangeLog.findFirst({
          where: {
            shop,
            inventoryItemId: inventoryItemIdRaw,
            locationId: locationIdRaw,
            activity: "admin_webhook",
            quantityAfter: available,
            timestamp: { gte: searchFrom, lte: searchTo },
          },
          orderBy: { timestamp: "desc" },
        });
        if (existingAdmin) {
          console.log(`[inventory_levels/update] Found admin_webhook with quantityAfter=${available} (post-sale value), will update to order_sales to avoid duplicate row`);
        }
      }
      if (existingAdmin) {
        const orderIdRef = `order_${pendingOrder.orderId}`;
        // 救済時は idempotencyKey を変更しない（orders/updated 等とキーが被ると P2002 になるため）
        await db.inventoryChangeLog.update({
          where: { id: existingAdmin.id },
          data: {
            activity: "order_sales",
            sourceType: "order_sales",
            sourceId: orderIdRef,
            delta: -pendingOrder.quantity,
            quantityAfter: available,
            note: `注文: #${pendingOrder.orderId}`,
          },
        });
        if (typeof db.orderPendingLocation !== "undefined") {
          await db.orderPendingLocation.deleteMany({
            where: { shop, orderId: pendingOrder.orderId, inventoryItemId: inventoryItemIdRaw, locationId: pendingOrder.locationId },
          });
        }
        console.log(`[inventory_levels/update] Updated existing admin_webhook to order_sales (avoid duplicate row): id=${existingAdmin.id}, orderId=${pendingOrder.orderId}, quantityAfter ${existingAdmin.quantityAfter} -> ${available}`);
        return new Response("OK", { status: 200 });
      }
    }

    // RefundPendingLocation にマッチした場合、既存の admin_webhook 行を refund に更新して新規行を作らない（売上と同様の二重防止）
    if (pendingRefund && db && typeof db.inventoryChangeLog !== "undefined") {
      const searchFrom = new Date(updatedAt.getTime() - 30 * 60 * 1000);
      const searchTo = new Date(updatedAt.getTime() + 5 * 60 * 1000);
      const expectedPrevQty = available - pendingRefund.quantity; // 返品前の在庫数
      const inventoryItemIdCandidates = [inventoryItemIdRaw, `gid://shopify/InventoryItem/${inventoryItemIdRaw}`];
      const locationIdCandidates = [locationIdRaw, `gid://shopify/Location/${locationIdRaw}`];
      let existingAdminRefund = await db.inventoryChangeLog.findFirst({
        where: {
          shop,
          inventoryItemId: { in: inventoryItemIdCandidates },
          locationId: { in: locationIdCandidates },
          activity: "admin_webhook",
          quantityAfter: expectedPrevQty,
          timestamp: { gte: searchFrom, lte: searchTo },
        },
        orderBy: { timestamp: "desc" },
      });
      // 先に届いた Webhook が「返品後」の値で admin_webhook 保存している場合（quantityAfter=available）。その行を refund に更新して二重行を防ぐ
      if (!existingAdminRefund && available !== expectedPrevQty) {
        existingAdminRefund = await db.inventoryChangeLog.findFirst({
          where: {
            shop,
            inventoryItemId: { in: inventoryItemIdCandidates },
            locationId: { in: locationIdCandidates },
            activity: "admin_webhook",
            quantityAfter: available,
            timestamp: { gte: searchFrom, lte: searchTo },
          },
          orderBy: { timestamp: "desc" },
        });
        if (existingAdminRefund) {
          console.log(`[inventory_levels/update] Found admin_webhook with quantityAfter=${available} (post-refund value), will update to refund to avoid duplicate row`);
        }
      }
      if (existingAdminRefund) {
        const orderIdRef = `order_${pendingRefund.orderId}`;
        // 救済時は idempotencyKey を変更しない（refunds/create 等とキーが被ると P2002 になるため）
        await db.inventoryChangeLog.update({
          where: { id: existingAdminRefund.id },
          data: {
            activity: "refund",
            sourceType: "refund",
            sourceId: orderIdRef,
            delta: pendingRefund.quantity,
            quantityAfter: available,
            note: `返品: 注文 #${pendingRefund.orderId}`,
          },
        });
        if (typeof db.refundPendingLocation !== "undefined") {
          await db.refundPendingLocation.deleteMany({
            where: { shop, refundId: pendingRefund.refundId, inventoryItemId: inventoryItemIdRaw, locationId: pendingRefund.locationId },
          });
        }
        console.log(`[inventory_levels/update] Updated existing admin_webhook to refund (avoid duplicate row): id=${existingAdminRefund.id}, refundId=${pendingRefund.refundId}, quantityAfter ${existingAdminRefund.quantityAfter} -> ${available}`);
        return new Response("OK", { status: 200 });
      }
    }

    // 在庫変動ログを保存（deltaがnullでも記録する）
    try {
      if (db && typeof db.inventoryChangeLog !== "undefined") {
        console.log(`[inventory_levels/update] Saving log: shop=${shop}, item=${inventoryItemIdRaw}, location=${locationIdRaw}, locationName=${locationName}, delta=${finalDelta}, quantityAfter=${available}, date=${date}, activity=${finalActivity}`);
        
        // deltaがnullの場合でも記録する。理由を note に残し、一覧で「-」の意味が分かるようにする。
        const noteForCreate =
          finalNote ??
          (finalDelta === null ? "変動数は直前ログが存在しなかったため記録されていません" : null);
        if (finalDelta === null) {
          console.log(`[inventory_levels/update] Saving log with delta=null (first event or no prev log), note will explain`);
        }

        await db.inventoryChangeLog.create({
          data: {
            shop,
            timestamp: updatedAt,
            date,
            inventoryItemId: inventoryItemIdRaw, // 元の形式を使用
            variantId,
            sku,
            locationId: locationIdRaw, // 元の形式を使用
            locationName, // ロケーション名は取得済み
            activity: finalActivity,
            delta: finalDelta,
            quantityAfter: available,
            sourceType: finalActivity,
            sourceId: finalSourceId,
            adjustmentGroupId,
            idempotencyKey: pendingOrder ? `${shop}_order_sales_${inventoryItemIdRaw}_${locationIdRaw}_order_${pendingOrder.orderId}_${updatedAt.toISOString()}` : pendingRefund ? `${shop}_refund_${inventoryItemIdRaw}_${locationIdRaw}_order_${pendingRefund.orderId}_${updatedAt.toISOString()}` : idempotencyKey,
            note: noteForCreate,
          },
        });
        
        if (pendingOrder && typeof db.orderPendingLocation !== "undefined") {
          await db.orderPendingLocation.deleteMany({
            where: { shop, orderId: pendingOrder.orderId, inventoryItemId: inventoryItemIdRaw, locationId: pendingOrder.locationId },
          });
          console.log(`[inventory_levels/update] Removed OrderPendingLocation for order ${pendingOrder.orderId}, item ${inventoryItemIdRaw}, locationId=${pendingOrder.locationId}`);
        }
        if (pendingRefund && typeof db.refundPendingLocation !== "undefined") {
          await db.refundPendingLocation.deleteMany({
            where: { shop, refundId: pendingRefund.refundId, inventoryItemId: inventoryItemIdRaw, locationId: pendingRefund.locationId },
          });
          console.log(`[inventory_levels/update] Removed RefundPendingLocation for refund ${pendingRefund.refundId}, item ${inventoryItemIdRaw}, locationId=${pendingRefund.locationId}`);
        }
        
        console.log(`[inventory_levels/update] Log saved successfully`);
      } else {
        console.warn(`[inventory_levels/update] InventoryChangeLog model not found in Prisma client. Please restart the dev server.`);
      }
    } catch (error: unknown) {
      // 並列で同じ Webhook が届いた場合など、idempotencyKey 重複で create が失敗することがある。1本は既に保存されているので成功扱いにする
      const prismaError = error as { code?: string; meta?: { target?: string[] } };
      if (prismaError?.code === "P2002" && Array.isArray(prismaError?.meta?.target) && prismaError.meta.target.includes("idempotencyKey")) {
        console.log(`[inventory_levels/update] Duplicate idempotencyKey (concurrent create), treating as success: item=${inventoryItemIdRaw}, location=${locationIdRaw}`);
      } else {
        console.error("[inventory_levels/update] Error saving inventory change log:", error);
      }
      // エラーが発生してもWebhookは成功として返す（リトライで二重送信を防ぐ）
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("inventory_levels/update webhook error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
