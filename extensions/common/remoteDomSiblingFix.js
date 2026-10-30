/**
 * POS UI 拡張ランタイムの DOM ポリフィル（@remote-dom/polyfill ≤1.5.x）の兄弟リンク不具合を補修する。
 *
 * 不具合: `insertBefore(child, ref)` で ref が「先頭以外」の子のとき、ref の直前ノードの
 * nextSibling が child ではなく ref を指したまま残る。childNodes 配列は正しいが
 * nextSibling 連結リストだけが壊れ、Preact の差分（nextSibling で挿入位置を辿る）が
 * 以降の更新で行の重複・欠落・並び崩れを起こし、最終的に
 * `undefined is not an object (evaluating 'e.nodeType')` で落ちる。
 * 上流では @remote-dom/polyfill の新しい版で修正済み（previous[NEXT] = child を追加）。
 *
 * 表示ページネーション（50件/ページ）は「件数が 51 件目に達した瞬間に、既存行の手前へ
 * 前へ/次へ を差し込む」「ページ送りで行を入れ替える」ため、この経路を確実に踏む。
 *
 * 方針: 起動時に切り離したノードで不具合の有無を検査し、壊れているときだけ
 * 挿入系メソッドを包んで、挿入後に直前ノードの nextSibling を正しく張り直す。
 * ランタイムが修正版なら何もしない。検査や補修に失敗しても描画は止めない。
 *
 * 各 POS 拡張の modal エントリで、render より前に 1 回 import する。
 */

const APPLIED_KEY = "__posStockRemoteDomSiblingFix";

/** 切り離したノードで不具合を再現し、壊れていれば next リンク用の内部キーを返す */
function detectBrokenNextKey(doc, tag) {
  const parent = doc.createElement(tag);
  const a = doc.createElement(tag);
  const b = doc.createElement(tag);
  const c = doc.createElement(tag);
  parent.appendChild(a);
  parent.appendChild(c);
  parent.insertBefore(b, c);
  if (a.nextSibling === b) return null; // 正常
  if (a.nextSibling !== c || b.nextSibling !== c || b.previousSibling !== a) return null; // 想定外の壊れ方は触らない

  // a[key] === c かつ b[key] === c となる内部キー（polyfill の NEXT）を特定する
  const keys = [...Object.getOwnPropertySymbols(a), ...Object.getOwnPropertyNames(a)];
  const candidates = keys.filter((k) => a[k] === c && b[k] === c);
  if (candidates.length !== 1) return null;
  const key = candidates[0];

  // 補修できることを確認してから採用する
  a[key] = b;
  if (a.nextSibling !== b) return null;
  return key;
}

function findOwner(obj, name) {
  let p = obj;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p);
  return p || null;
}

export function installRemoteDomSiblingFix(doc = globalThis.document) {
  try {
    if (!doc?.createElement || globalThis[APPLIED_KEY]) return false;
    // ランタイムが素の HTML 要素を作れない場合に備え、POS コンポーネント要素でも検査する
    let nextKey = null;
    let probeTag = null;
    for (const tag of ["div", "s-box"]) {
      try {
        nextKey = detectBrokenNextKey(doc, tag);
        probeTag = tag;
        break;
      } catch (_) {}
    }
    if (nextKey == null) return false;

    const relink = (node) => {
      const prev = node?.previousSibling;
      if (prev && prev[nextKey] !== node && node.parentNode && prev.parentNode === node.parentNode) {
        prev[nextKey] = node;
      }
    };

    // 渡されたノード（DocumentFragment なら中身）を挿入後に張り直す
    const wrapInsertion = (owner, name, getInserted) => {
      const original = owner?.[name];
      if (typeof original !== "function") return;
      owner[name] = function patchedInsertion(...args) {
        const inserted = getInserted(args);
        const result = original.apply(this, args);
        for (const n of inserted) relink(n);
        return result;
      };
    };
    const insertedFrom = (node) =>
      node?.nodeType === 11 ? Array.from(node.childNodes || []) : node ? [node] : [];

    const probe = doc.createElement(probeTag);
    const insertInto = findOwner(probe, "insertInto");
    if (insertInto) {
      // insertBefore / appendChild / replaceChild / prepend などは全て insertInto を通る
      wrapInsertion(insertInto, "insertInto", ([child]) => insertedFrom(child));
    } else {
      wrapInsertion(findOwner(probe, "insertBefore"), "insertBefore", ([child]) => insertedFrom(child));
      wrapInsertion(findOwner(probe, "replaceChild"), "replaceChild", ([child]) => insertedFrom(child));
    }

    globalThis[APPLIED_KEY] = true;
    try {
      console.info("[pos-stock] remote-dom sibling fix applied");
    } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

installRemoteDomSiblingFix();
