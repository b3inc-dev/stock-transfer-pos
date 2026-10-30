import test from "node:test";
import assert from "node:assert/strict";
import { installRemoteDomSiblingFix } from "../extensions/common/remoteDomSiblingFix.js";

// @remote-dom/polyfill 1.4.x〜1.5.x の ParentNode.insertInto と同じ連結リスト処理を最小再現する。
// insertBefore(child, ref) で ref の直前ノードの NEXT を更新しない（＝不具合）。
const PREV = Symbol("prev");
const NEXT = Symbol("next");
const CHILD = Symbol("child");
const PARENT = Symbol("parent");

function makeDom({ buggy }) {
  class Node {
    constructor(name) {
      this.name = name;
      this.nodeType = 1;
      this[PREV] = null;
      this[NEXT] = null;
      this[CHILD] = null;
      this[PARENT] = null;
      this.childNodes = [];
    }
    get nextSibling() {
      return this[NEXT];
    }
    get previousSibling() {
      return this[PREV];
    }
    get parentNode() {
      return this[PARENT];
    }
    get firstChild() {
      return this[CHILD];
    }
    appendChild(child) {
      this.insertInto(child, null);
      return child;
    }
    insertBefore(child, ref) {
      this.insertInto(child, ref || null);
      return child;
    }
    removeChild(child) {
      const prev = child[PREV];
      const next = child[NEXT];
      if (prev) prev[NEXT] = next;
      else this[CHILD] = next;
      if (next) next[PREV] = prev;
      this.childNodes.splice(this.childNodes.indexOf(child), 1);
      child[PARENT] = null;
      child[NEXT] = null;
      child[PREV] = null;
    }
    insertInto(child, before) {
      if (child[PARENT]) child[PARENT].removeChild(child);
      if (before) {
        child[NEXT] = before;
        child[PREV] = before[PREV];
        if (before[PREV] === null) this[CHILD] = child;
        else if (!buggy) before[PREV][NEXT] = child;
        before[PREV] = child;
        this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
      } else {
        child[NEXT] = null;
        let last = this[CHILD];
        if (last) {
          while (last[NEXT]) last = last[NEXT];
          last[NEXT] = child;
          child[PREV] = last;
        } else {
          this[CHILD] = child;
          child[PREV] = null;
        }
        this.childNodes.push(child);
      }
      child[PARENT] = this;
    }
  }
  return { Node, document: { createElement: (name) => new Node(name) } };
}

function walk(parent) {
  const out = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) out.push(n.name);
  return out;
}

function resetApplied() {
  delete globalThis.__posStockRemoteDomSiblingFix;
}

test("buggy polyfill: inserting before a middle child breaks nextSibling (reproduction)", () => {
  const { document } = makeDom({ buggy: true });
  const p = document.createElement("p");
  for (const n of ["title", "spacer", "row1", "row2"]) p.appendChild(document.createElement(n));
  // 51 件目で「前へ/次へ」が row1 の手前に入るのと同じ操作
  p.insertBefore(document.createElement("controls"), p.childNodes[2]);
  assert.deepEqual(p.childNodes.map((n) => n.name), ["title", "spacer", "controls", "row1", "row2"]);
  assert.deepEqual(walk(p), ["title", "spacer", "row1", "row2"]);
});

test("installRemoteDomSiblingFix repairs middle insertions on a buggy polyfill", () => {
  resetApplied();
  const { document } = makeDom({ buggy: true });
  assert.equal(installRemoteDomSiblingFix(document), true);

  const p = document.createElement("p");
  for (const n of ["title", "spacer", "row1", "row2", "row3"]) p.appendChild(document.createElement(n));
  p.insertBefore(document.createElement("controls"), p.childNodes[2]);
  p.insertBefore(document.createElement("gap"), p.childNodes[3]);
  // 既存ノードの移動（並べ替え）も同じ経路
  p.insertBefore(p.childNodes[6], p.childNodes[4]);
  assert.deepEqual(walk(p), p.childNodes.map((n) => n.name));
  assert.deepEqual(walk(p), ["title", "spacer", "controls", "gap", "row3", "row1", "row2"]);
  resetApplied();
});

test("installRemoteDomSiblingFix leaves a correct DOM untouched", () => {
  resetApplied();
  const { Node, document } = makeDom({ buggy: false });
  const original = Node.prototype.insertInto;
  assert.equal(installRemoteDomSiblingFix(document), false);
  assert.equal(Node.prototype.insertInto, original);
  resetApplied();
});

test("installRemoteDomSiblingFix is a no-op without a document", () => {
  resetApplied();
  assert.equal(installRemoteDomSiblingFix(undefined), false);
});
