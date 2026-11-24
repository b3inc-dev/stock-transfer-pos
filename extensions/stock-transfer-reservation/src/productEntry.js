/** Read-only bootstrap: never overwrite a previous draft or submit inventory from a product action. */
export async function loadProductReservationDraft({ storage, storageKey, product, productSearch, createDraft }) {
  const saved = await storage.get(storageKey);
  const draft = saved || createDraft();
  // An unresolved submission must keep its exact payload; don't even fetch another variant yet.
  if (draft.submitted) return { kind: "submitted", draft };
  const variantId = product?.variantId;
  const productId = product?.id;
  if (!Number.isSafeInteger(variantId) || variantId < 1 || !Number.isSafeInteger(productId) || productId < 1) throw new Error("商品詳細で種類を選んでから、もう一度「取置する」を押してください");
  const variant = await productSearch.fetchProductVariantWithId(variantId);
  if (!variant || variant.id !== variantId || variant.productId !== productId || !(variant.displayName || variant.title)) throw new Error("商品を読み込めませんでした。商品詳細からもう一度開いてください");
  const line = { variantId: `gid://shopify/ProductVariant/${variantId}`, title: variant.displayName || variant.title, quantity: 1 };
  if ((draft.lines || []).some(item => item.variantId === line.variantId)) return { kind: "ready", draft };
  if (draft.lines?.length || draft.name || draft.phone) return { kind: "confirm", draft, line };
  return { kind: "ready", draft: appendProductToDraft(draft, line) };
}
export function appendProductToDraft(draft, line) {
  if (draft.submitted) throw new Error("前回の登録結果を確認してから、新しい商品を追加してください");
  const lines = draft.lines || [];
  if (lines.some(item => item.variantId === line.variantId)) return draft;
  if (lines.length >= 250) throw new Error("商品は250明細までです。入力中の取置を先に確認してください");
  return { ...draft, lines: [...lines, line] };
}

/** Serialize local draft saves so an older autosave cannot win after Back or submission. */
export function createReservationDraftWriter(storage, storageKey) {
  let tail = Promise.resolve();
  return {
    save(value) {
      const next = tail.catch(() => {}).then(() => storage.set(storageKey, value));
      tail = next;
      return next.catch(() => { throw new Error("下書きを保存できません。画面を閉じずに、もう一度お試しください"); });
    },
  };
}

/** Keep guest input separate from the exact wire payload used for an uncertain member submission. */
export function restoreReservationInputDraft(saved) {
  return { ...saved, phone: saved.submitted === true ? saved.guestDraftPhone ?? (saved.customerId ? "" : saved.phone) : saved.phone };
}
