/**
 * 管理画面の在庫の書き込みのキー（サーバー側）。設計: docs/IDEMPOTENT_MIGRATION.md 4.6。
 *
 * 操作の ID = 画面の opKey + 対象（棚卸の ID・発注の ID・仕入れの ID）+ 動き（confirm・revert など）+ グループ。
 * 回       = 「戻した回数」（rv1, rv2…。0 回なら main）+ 画面の opRound（はっきり断られた回数。.rej1…）。
 *
 * 「戻した回数」はサーバーがデータ（棚卸・発注の記録）に持つ。書いたものを元に戻し、同じ中身をもう一度送るとき
 * （棚卸の確定 → 取り消し → 確定、発注の承認 → 承認の取り消し → 承認）は、画面の opKey が同じでも必ず新しいキーになる
 * （同じキーだと Shopify は前の成功の答えだけを返して書かない。設計 3.1）。
 */
import { randomUUID } from "node:crypto";
import {
  ADMIN_OP_KEY_FIELD,
  ADMIN_OP_ROUND_FIELD,
  ADMIN_OP_ROUND_MAX,
  isAdminOpKey,
  type AdminOpKeyResult,
} from "./admin-op-key";
import {
  buildIdempotencyKeyServer,
  classifyIdempotencyErrors,
  type IdempotencyIssue,
} from "./idempotency-key.server";

export type { AdminOpKeyResult };

/** 操作の種類（キーの材料。変えない） */
export const ADMIN_IDEMPOTENCY_KIND = {
  inventoryCount: "admin_inventory_count",
  orderTransfer: "admin_order_transfer",
  purchase: "admin_purchase",
} as const;

export type AdminOpKeyInput = {
  /** 画面から来た opKey。無い・形が違うときは null（古い画面） */
  opKey: string | null;
  /** 画面から来た opRound（0 以上の整数） */
  opRound: number;
};

/** FormData から opKey・opRound を読む。おかしな値は「無い」とみなす */
export function readAdminOpKey(formData: { get(name: string): unknown }): AdminOpKeyInput {
  const rawKey = formData.get(ADMIN_OP_KEY_FIELD);
  const opKey = isAdminOpKey(rawKey) ? String(rawKey).trim().toLowerCase() : null;
  const rawRound = Number(String(formData.get(ADMIN_OP_ROUND_FIELD) ?? "0").trim());
  const opRound = Number.isInteger(rawRound) && rawRound > 0 ? Math.min(ADMIN_OP_ROUND_MAX, rawRound) : 0;
  return { opKey, opRound };
}

/** データに持つ「戻した回数」を読む（無い・おかしい値は 0） */
export function readRevertRound(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 回の文字列。rv0 = main。opRound > 0 なら .rejN を足す */
export function buildAdminRound(revertRound: number, opRound: number): string {
  const rv = readRevertRound(revertRound);
  const rej = Number.isInteger(opRound) && opRound > 0 ? Math.min(ADMIN_OP_ROUND_MAX, opRound) : 0;
  return `${rv > 0 ? `rv${rv}` : "main"}${rej > 0 ? `.rej${rej}` : ""}`;
}

/** 操作の ID の 1 つの部品。区切り（":" と キーの "|"）が中に入っても混ざらないように符号にする */
function encodePart(value: unknown): string {
  const s = String(value ?? "").trim();
  return s ? encodeURIComponent(s) : "-";
}

export type AdminIdempotency = {
  shop: string;
  kind: string;
  operationId: string;
  round: string;
  /** opKey が無かった（古い画面）。呼ぶたびに違うキー＝今までと同じ動きで、守りは増えない */
  adhoc: boolean;
  concurrentRetryDelaysMs?: number[];
};

/**
 * 管理画面の 1 つの操作のキーの材料を作る（段とチャンクは書き込むところで足す）。
 * @param parts 対象と動き（例: [countId, "confirm", groupId]）
 */
export function buildAdminIdempotency(args: {
  shop: string;
  kind: string;
  op: AdminOpKeyInput;
  parts: ReadonlyArray<unknown>;
  revertRound?: number;
  concurrentRetryDelaysMs?: number[];
}): AdminIdempotency {
  const adhoc = !args.op.opKey;
  const opKey = args.op.opKey ?? `adhoc-${randomUUID()}`;
  return {
    shop: String(args.shop || "").trim() || "unknown-shop",
    kind: args.kind,
    operationId: [opKey, ...args.parts.map(encodePart)].join(":"),
    round: buildAdminRound(args.revertRound ?? 0, args.op.opRound),
    adhoc,
    concurrentRetryDelaysMs: args.concurrentRetryDelaysMs,
  };
}

/** 段・チャンクを足してキー（UUID v5）にする */
export function adminIdempotencyKey(idem: AdminIdempotency, stage: string, chunk = "1/1"): string {
  return buildIdempotencyKeyServer({
    shop: idem.shop,
    kind: idem.kind,
    operationId: idem.operationId,
    stage,
    chunk,
    round: idem.round,
  });
}

export type AdminWriteClassification =
  | { outcome: "ok" }
  | { outcome: "rejected"; message: string }
  | { outcome: "uncertain"; message: string; idempotencyIssue: IdempotencyIssue | null };

type UserErrorLike = { field?: unknown; message?: unknown; code?: unknown };

/**
 * 1 回の書き込みの答えを分ける（graphql-with-retry の retryWhileIdempotencyConcurrent のあとで使う）。
 * - userErrors に @idempotent の返事（処理中・中身の違い）→ uncertain（はっきりした断りにしない。キーを変えない）
 * - それ以外の userErrors → rejected（はっきり断られた。画面は回を増やす）
 * - トップの errors だけ → uncertain（作れたか分からない）
 */
export function classifyAdminWrite(
  userErrors: ReadonlyArray<UserErrorLike> | null | undefined,
  topErrors: ReadonlyArray<{ message?: unknown; extensions?: { code?: unknown } | null }> | null | undefined,
  concurrentExhausted = false
): AdminWriteClassification {
  const ue = userErrors ?? [];
  const te = topErrors ?? [];
  const issue = classifyIdempotencyErrors(ue as never, te as never);
  const message = [...ue, ...te].map((e) => String(e?.message ?? "")).filter(Boolean).join(" / ");
  if (issue === "mismatch") {
    return { outcome: "uncertain", message: message || "IDEMPOTENCY_KEY_PARAMETER_MISMATCH", idempotencyIssue: "mismatch" };
  }
  if (issue === "concurrent" || concurrentExhausted) {
    return { outcome: "uncertain", message: message || "IDEMPOTENCY_CONCURRENT_REQUEST", idempotencyIssue: "concurrent" };
  }
  if (ue.length > 0) return { outcome: "rejected", message };
  if (te.length > 0) return { outcome: "uncertain", message, idempotencyIssue: null };
  return { outcome: "ok" };
}

/** 結果が分からないときに画面に出す文（管理者が Shopify で確かめる。設計 3.3） */
export const ADMIN_UNCERTAIN_MESSAGE =
  "在庫に反映されたか確かめられませんでした。Shopify の管理画面で在庫（または移管）を確かめてから、画面を読み込み直さずに同じ画面でもう一度押してください（24 時間以内なら二重には反映されません）。";

/**
 * metafieldsSet（記録の保存）の答えを読む。失敗なら理由の文、成功なら null。
 * 在庫・移管を書いたあとの記録の保存が失敗したときは、画面に uncertain を返す（opKey を変えない）。
 * 同じ opKey で押し直すと同じキーになり、Shopify は書かずに前の答えを返すので、記録だけが書き直される。
 */
export async function metafieldsSetError(send: () => Promise<Response>): Promise<string | null> {
  try {
    const resp = await send();
    const json = (await resp.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } | null };
      errors?: Array<{ message?: string }>;
    };
    const errs = [...(json?.data?.metafieldsSet?.userErrors ?? []), ...(json?.errors ?? [])];
    if (errs.length > 0) return errs.map((e) => String(e?.message ?? "")).filter(Boolean).join(" / ") || "記録の保存に失敗しました";
    if (!json?.data?.metafieldsSet) return "記録の保存の答えがありません";
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 在庫・移管は書けたが記録の保存に失敗したときの文 */
export function adminRecordSaveFailedMessage(detail: string): string {
  return `Shopify には反映しましたが、アプリの記録の保存に失敗しました（${detail}）。画面を読み込み直さずに、同じ画面でもう一度押してください（24 時間以内なら Shopify には二重に反映されません）。`;
}
