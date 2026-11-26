/**
 * 在庫の書き込み（Shopify の @idempotent）に付けるキーを作る共通部品。
 * 設計: docs/IDEMPOTENT_MIGRATION.md の 3 章。
 *
 * key = UUIDv5(名前空間, "pst1|shop|操作の種類|操作の ID|段|チャンク|回")
 *
 * - 同じ材料からは、いつ・どこで作っても同じ UUID になる（POS とサーバーで同じ）。
 * - 応答なし・時間切れ・429・5xx・処理中の送り直しは材料を変えない → 同じキー。
 * - 新しい操作は「操作の ID」が変わる → 新しいキー。
 * - はっきり断られたあと・わざと中身を変えて送り直すときは「回」を変える → 新しいキー。
 *
 * POS でも動くように、部品（npm）や crypto.subtle には頼らず SHA-1 をここで計算する。
 * サーバーは app/utils/idempotency-key.server.ts で node:crypto を使うが、材料の並べ方はこのファイルのものを使う。
 * 材料に個人の情報（名前・メール）は入れない。ID だけ。
 */

/** このアプリ専用の名前空間（変えない。変えると送り直しのキーが前と変わる） */
export const IDEMPOTENCY_KEY_NAMESPACE = "c5bcfcd2-b8f6-422b-a82c-b16e257f07a2";

/** 材料の並べ方の版。並べ方を変えるときだけ上げる */
export const IDEMPOTENCY_KEY_MATERIAL_VERSION = "pst1";

const PART_NAMES = ["shop", "kind", "operationId", "stage", "chunk", "round"];

function partToString(name, value) {
  if (value == null) throw new TypeError(`idempotency key: ${name} がありません`);
  const s = String(value).trim();
  if (!s) throw new TypeError(`idempotency key: ${name} が空です`);
  // 区切りの "|" が中に入ると、違う材料が同じ文字列になりうる
  if (s.includes("|")) throw new TypeError(`idempotency key: ${name} に "|" は使えません`);
  return s;
}

/**
 * チャンクの書き方（1 から数える）。分けないときは "1/1"。
 * @param {number} index0 0 から数えた番号
 * @param {number} total チャンクの数
 */
export function formatIdempotencyChunk(index0, total) {
  const i = Math.floor(Number(index0));
  const n = Math.floor(Number(total));
  if (!Number.isFinite(i) || !Number.isFinite(n) || n < 1 || i < 0 || i >= n) {
    throw new TypeError(`idempotency key: チャンクの番号が正しくありません（${index0}/${total}）`);
  }
  return `${i + 1}/${n}`;
}

/**
 * キーの材料の文字列を作る（ハッシュの前）。
 * @param {{ shop: string, kind: string, operationId: string, stage: string, chunk?: string, round?: string }} parts
 */
export function buildIdempotencyKeyMaterial(parts) {
  const p = { chunk: "1/1", round: "main", ...(parts || {}) };
  const values = PART_NAMES.map((name) => partToString(name, p[name]));
  return [IDEMPOTENCY_KEY_MATERIAL_VERSION, ...values].join("|");
}

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

/** SHA-1（20 バイトの配列を返す）。UUID v5 のためだけに使う（暗号の強さは要らない） */
export function sha1Bytes(bytes) {
  const msg = Array.from(bytes);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  msg.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let off = 0; off < msg.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
    }
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f;
      let k;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl(a, 5) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = [];
  for (const h of [h0, h1, h2, h3, h4]) out.push((h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV5(value) {
  return typeof value === "string" && UUID_V5_RE.test(value);
}

/** UUID の文字列を 16 バイトにする */
export function uuidToBytes(uuid) {
  if (!UUID_RE.test(String(uuid))) throw new TypeError(`UUID の形ではありません: ${uuid}`);
  const hex = String(uuid).replace(/-/g, "").toLowerCase();
  const out = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** SHA-1 の 20 バイトから UUID v5 の文字列を作る（版と variant の bit を立てる） */
export function uuidV5FromSha1(hash) {
  const b = Array.from(hash).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 4122 の UUID v5（名前空間 + 名前） */
export function uuidV5(name, namespace = IDEMPOTENCY_KEY_NAMESPACE) {
  return uuidV5FromSha1(sha1Bytes([...uuidToBytes(namespace), ...utf8Bytes(String(name))]));
}

/**
 * 在庫の書き込みのキー（36 文字の UUID v5）。
 * @param {{ shop: string, kind: string, operationId: string, stage: string, chunk?: string, round?: string }} parts
 */
export function buildIdempotencyKey(parts) {
  return uuidV5(buildIdempotencyKeyMaterial(parts));
}
