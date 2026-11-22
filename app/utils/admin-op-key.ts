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
 * サーバーは在庫を書く操作の答えに `opKeyResult` と、送られてきた `opKey` をそのまま入れる。画面はその opKey を持つ
 * 対象（仕入れ・発注の 1 件、棚卸の 1 つの動き）だけを、上の 3 つのどれかにする。
 *
 * **opKey は対象ごとに持つ**（画面に 1 つではない）。1 つだと、仕入れ X が「分からない」のまま別の仕入れ Y が成功したときに
 * opKey が作り直され、X を押し直すと新しいキーになって、X の前の送信が通っていれば二重に足されるため。
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

/** 答え（fetcher.data）から、サーバーが返した opKey を読む。無い・形が違うときは null */
export function readAdminOpKeyEcho(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const k = (data as { opKey?: unknown }).opKey;
  return isAdminOpKey(k) ? k.trim().toLowerCase() : null;
}

/**
 * 対象ごとの opKey の表に答えを当てる（画面のフックから使う。テストできるように分けてある）。
 * 答えの opKey を持つ対象だけを進める。opKey が無い答え・どの対象のものでもない答えは何も変えない。
 * @returns 変えた対象の名前（無ければ null）
 */
export function applyAdminOpKeyResult(states: Map<string, AdminOpKeyState>, data: unknown): string | null {
  const result = readAdminOpKeyResult(data);
  const echoed = readAdminOpKeyEcho(data);
  if (!result || !echoed) return null;
  for (const [target, st] of states) {
    if (st.opKey.toLowerCase() === echoed) {
      states.set(target, nextAdminOpKeyState(st, result));
      return target;
    }
  }
  return null;
}

/** 対象の opKey（無ければ作る） */
export function adminOpKeyStateFor(states: Map<string, AdminOpKeyState>, target: string): AdminOpKeyState {
  const t = String(target ?? "");
  let st = states.get(t);
  if (!st) {
    st = initialAdminOpKeyState();
    states.set(t, st);
  }
  return st;
}
