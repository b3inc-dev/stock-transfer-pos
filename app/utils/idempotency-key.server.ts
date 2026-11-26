/**
 * サーバーで在庫の書き込み（Shopify の @idempotent）に付けるキーと、その返事の分け方。
 * 設計: docs/IDEMPOTENT_MIGRATION.md の 3 章・4.5。
 *
 * 材料の並べ方は POS と同じ `extensions/common/idempotencyKey.js` のものを使う（決まりを 1 か所にする）。
 * ハッシュだけ node:crypto で計算し、POS の JS の計算と同じ答えになることをテストの表で確かめる。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_KEY_NAMESPACE,
  buildIdempotencyKeyMaterial,
  formatIdempotencyChunk,
  uuidToBytes,
  uuidV5FromSha1,
} from "../../extensions/common/idempotencyKey.js";

export { IDEMPOTENCY_KEY_NAMESPACE, buildIdempotencyKeyMaterial, formatIdempotencyChunk };

export type IdempotencyKeyParts = {
  shop: string;
  /** 操作の種類（`apply_change` など） */
  kind: string;
  /** 今ある再試行の ID（apply-change は InventoryChangeEvent.id） */
  operationId: string;
  /** 1 つの操作の中の書き込みの種類（`set_fwd`・`set_rb`・`activate:…` など） */
  stage: string;
  /** "i/n"（1 から数える）。既定 "1/1" */
  chunk?: string;
  /** はっきり断られたあと・わざと中身を変えるときだけ変える。既定 "main" */
  round?: string;
};

/** node:crypto で計算する UUID v5（RFC 4122） */
export function uuidV5Server(name: string, namespace: string = IDEMPOTENCY_KEY_NAMESPACE): string {
  const hash = createHash("sha1")
    .update(Buffer.from(uuidToBytes(namespace)))
    .update(Buffer.from(String(name), "utf8"))
    .digest();
  return uuidV5FromSha1(Array.from(hash));
}

/** 在庫の書き込みのキー（36 文字の UUID v5） */
export function buildIdempotencyKeyServer(parts: IdempotencyKeyParts): string {
  return uuidV5Server(buildIdempotencyKeyMaterial(parts));
}

/**
 * 呼び出し元から渡す「この書き込みの操作」の情報。
 * round は呼ぶ場所ごとに分ける（同じ操作の中で、断られたあとに呼び直すときは別の round）。
 */
export type IdempotencyContext = {
  shop: string;
  operationId: string;
  round?: string;
  /** IDEMPOTENCY_CONCURRENT_REQUEST のときに待つ時間（テスト用に短くできる）。既定 1 秒・2 秒・4 秒 */
  concurrentRetryDelaysMs?: number[];
};

/**
 * 呼び出し元が操作の ID を渡さなかったとき（親の操作が無い呼び出し）の代わり。
 * 呼ぶたびに新しい ID（同じ呼び出しの中の送り直しだけ同じキー）。今と同じ動きで、守りは増えない。
 */
export function resolveIdempotencyContext(ctx: IdempotencyContext | null | undefined, fallbackShop = "unknown-shop"): Required<
  Pick<IdempotencyContext, "shop" | "operationId" | "round">
> & { concurrentRetryDelaysMs: number[] } {
  return {
    shop: ctx?.shop?.trim() || fallbackShop,
    operationId: ctx?.operationId?.trim() || `adhoc-${randomUUID()}`,
    round: ctx?.round?.trim() || "main",
    concurrentRetryDelaysMs: ctx?.concurrentRetryDelaysMs ?? [...DEFAULT_CONCURRENT_RETRY_DELAYS_MS],
  };
}

export const DEFAULT_CONCURRENT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

export const IDEMPOTENCY_CONCURRENT_REQUEST = "IDEMPOTENCY_CONCURRENT_REQUEST";
export const IDEMPOTENCY_KEY_PARAMETER_MISMATCH = "IDEMPOTENCY_KEY_PARAMETER_MISMATCH";

export type IdempotencyIssue = "concurrent" | "mismatch";

type ErrorLike = { code?: unknown; message?: unknown; extensions?: { code?: unknown } | null } | null | undefined;

function issueOf(e: ErrorLike): IdempotencyIssue | null {
  const code = String(e?.code ?? e?.extensions?.code ?? "").trim().toUpperCase();
  if (code === IDEMPOTENCY_CONCURRENT_REQUEST) return "concurrent";
  if (code === IDEMPOTENCY_KEY_PARAMETER_MISMATCH) return "mismatch";
  // `code` を持たない UserError（inventoryActivate など）は文で見分ける（Shopify の手引きの文）
  const msg = String(e?.message ?? "");
  if (/same idempotency key cannot be used with different|same idempotency key was used with different/i.test(msg)) {
    return "mismatch";
  }
  if (/request is currently in progress|another request with the same idempotency key/i.test(msg)) {
    return "concurrent";
  }
  return null;
}

/**
 * userErrors（とトップの errors）に @idempotent の返事があるか。
 * mismatch を concurrent より優先する（中身が違うのは作りの間違いで、待っても直らない）。
 * どちらも「はっきりした断り」ではない（在庫が動いたか分からない）ので、呼び出し側は finalRejection に入れない。
 */
export function classifyIdempotencyErrors(...lists: Array<ReadonlyArray<ErrorLike> | null | undefined>): IdempotencyIssue | null {
  let found: IdempotencyIssue | null = null;
  for (const list of lists) {
    for (const e of list ?? []) {
      const issue = issueOf(e);
      if (issue === "mismatch") return "mismatch";
      if (issue === "concurrent") found = "concurrent";
    }
  }
  return found;
}
