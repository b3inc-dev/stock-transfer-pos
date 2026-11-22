/**
 * POS の有効化（inventoryActivate）の @idempotent のキー（docs/IDEMPOTENT_MIGRATION.md 4.3 の F）。
 * 段の形はサーバー（app/utils/ensure-inventory-activated-server.ts）と同じ `activate:<置き場所>:<商品>:<初めの数>:<初めの数>`。
 * POS は初めの数を渡さないので `-:-`。
 *
 * - 操作の ID: 有効化の呼び出しごとに新しい ID（newAdhocOperationId）。同じ呼び出しの中の送り直しだけ同じキーになる
 * - 回: `main`、はっきり断られるたびに `.rej1`・`.rej2`…（同じキーだと前の断りがそのまま返ることがある）
 * - 通信の失敗・処理中の送り直しは回を増やさない（同じキー）
 */
import { buildIdempotencyKey } from "./idempotencyKey.js";
import { currentShopDomain } from "./shipmentReceive.js";

export const POS_ACTIVATE_KIND = "pos_activate";

const clip = (s) => String(s ?? "").trim().replace(/\|/g, "%7C");

export function buildActivateKeyForPos({ shop, operationId, locationId, inventoryItemId, rejections = 0 }) {
  const n = Math.max(0, Math.floor(Number(rejections) || 0));
  return buildIdempotencyKey({
    shop: clip(shop) || currentShopDomain(),
    kind: POS_ACTIVATE_KIND,
    operationId: clip(operationId),
    stage: `activate:${clip(locationId)}:${clip(inventoryItemId)}:-:-`,
    chunk: "1/1",
    round: n > 0 ? `main.rej${n}` : "main",
  });
}
