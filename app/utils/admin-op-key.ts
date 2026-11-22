/**
 * 管理画面の在庫の書き込み（棚卸の確定・取り消し・発注から移管・仕入れの確定・取り消し）で使う
 * 「画面の操作の ID」（opKey）と「回」（opRound）。設計: docs/IDEMPOTENT_MIGRATION.md 3.2・4.6。
 *
 * このファイルは画面（ブラウザ）とサーバーの両方から読む。node: の部品も react も使わない。
 *
 * - opKey: 画面を開いたときに UUID を作る。**成功がはっきりしたら作り直す**。
 * - opRound: **はっきり断られたら 1 つ増やす**（同じキーだと前の断りがそのまま返ることがあるため）。
 * - 結果が分からないとき（通信の失敗・サーバーの例外・処理中のまま・中身の違い）は**どちらも変えない**
 *   （次に押したときに同じキーになり、前の送信が通っていれば Shopify は 2 回目を動かさない）。
 *
 * サーバーは在庫を書く操作の答えに `opKeyResult` を入れる。画面はそれを見て上の 3 つのどれかにする。
 */

export const ADMIN_OP_KEY_FIELD = "opKey";
export const ADMIN_OP_ROUND_FIELD = "opRound";

/** サーバーが答えに入れる。done = 成功がはっきり、rejected = はっきり断られた、uncertain = 分からない */
export type AdminOpKeyResult = "done" | "rejected" | "uncertain";

export type AdminOpKeyState = { opKey: string; opRound: number };

/** 回の上限（これより大きい数が送られてきたら上限にそろえる。キーの材料が長くなりすぎないように） */
export const ADMIN_OP_ROUND_MAX = 999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAdminOpKey(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/** 新しい opKey（UUID v4）。crypto.randomUUID が無い古いブラウザでは getRandomValues、それも無ければ Math.random */
export function newAdminOpKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function initialAdminOpKeyState(): AdminOpKeyState {
  return { opKey: newAdminOpKey(), opRound: 0 };
}

/** 答えを見て次の状態を決める（画面のフックから使う。テストできるように分けてある） */
export function nextAdminOpKeyState(state: AdminOpKeyState, result: AdminOpKeyResult | null | undefined): AdminOpKeyState {
  if (result === "done") return initialAdminOpKeyState();
  if (result === "rejected") return { opKey: state.opKey, opRound: Math.min(ADMIN_OP_ROUND_MAX, state.opRound + 1) };
  return state;
}

/** 送る FormData に opKey と opRound を入れる */
export function appendAdminOpKey(formData: FormData, state: AdminOpKeyState): FormData {
  formData.set(ADMIN_OP_KEY_FIELD, state.opKey);
  formData.set(ADMIN_OP_ROUND_FIELD, String(state.opRound));
  return formData;
}

/** 答え（fetcher.data）から opKeyResult を読む。無ければ null（在庫を書かない操作の答え） */
export function readAdminOpKeyResult(data: unknown): AdminOpKeyResult | null {
  if (!data || typeof data !== "object") return null;
  const r = (data as { opKeyResult?: unknown }).opKeyResult;
  return r === "done" || r === "rejected" || r === "uncertain" ? r : null;
}
