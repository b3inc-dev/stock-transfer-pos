/**
 * 入庫モーダルの単一ホスト（POS remote-ui 安全側）
 *
 * 行ごとに s-modal をネストすると、明細オープン時に数十〜数百の remote ノードが
 * s-scroll-box 配下へ同時マウントされ、Preact/remote-dom 差分で
 * `undefined is not an object (evaluating 'e.nodeType')` を起こしうる。
 * 出庫の DialogHost 同様、s-page の外に 1 つだけ数量モーダルを置く。
 */
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";

export const INBOUND_SHARED_QTY_MODAL_ID = "inbound-shared-qty-modal";

const InboundQtyEditorContext = createContext(null);

/**
 * @typedef {{
 *   title?: string,
 *   value: number,
 *   min?: number,
 *   max?: number,
 *   onSetQty?: (n: number) => void,
 *   onRemove?: (() => void) | null,
 *   primaryLabel?: string,
 * }} QtyEditorRequest
 */

export function useInboundQtyEditor() {
  return useContext(InboundQtyEditorContext);
}

export function InboundQtyEditorProvider({ children }) {
  const [editor, setEditor] = useState(/** @type {QtyEditorRequest | null} */ (null));
  const [text, setText] = useState("1");
  const modalRef = useRef(null);
  const openRef = useRef(false);

  const openOverlay = useCallback(() => {
    if (openRef.current) return;
    try {
      modalRef.current?.showOverlay?.();
    } catch (_) {}
    openRef.current = true;
  }, []);

  const closeOverlay = useCallback(() => {
    if (!openRef.current) return;
    try {
      modalRef.current?.hideOverlay?.();
    } catch (_) {
      try {
        document.querySelector(`#${INBOUND_SHARED_QTY_MODAL_ID}`)?.hide?.();
      } catch (_) {}
    }
    openRef.current = false;
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(null);
    closeOverlay();
  }, [closeOverlay]);

  const openQtyEditor = useCallback((req) => {
    const min = Number.isFinite(Number(req?.min)) ? Number(req.min) : 0;
    const max = Number.isFinite(Number(req?.max)) ? Number(req.max) : 999999;
    const value = Number.isFinite(Number(req?.value)) ? Number(req.value) : min;
    setEditor({
      title: String(req?.title || "数量"),
      value,
      min,
      max,
      onSetQty: typeof req?.onSetQty === "function" ? req.onSetQty : undefined,
      onRemove: typeof req?.onRemove === "function" ? req.onRemove : null,
      primaryLabel: String(req?.primaryLabel || "OK"),
    });
    setText(String(value));
  }, []);

  useEffect(() => {
    if (editor) openOverlay();
    else closeOverlay();
  }, [editor, openOverlay, closeOverlay]);

  const clamp = (n) => {
    const min = Number.isFinite(Number(editor?.min)) ? Number(editor.min) : 0;
    const max = Number.isFinite(Number(editor?.max)) ? Number(editor.max) : 999999;
    return Math.min(max, Math.max(min, Math.floor(Number(n || min))));
  };

  const host = (
    <s-modal
      ref={modalRef}
      id={INBOUND_SHARED_QTY_MODAL_ID}
      heading={editor?.title || "数量"}
    >
      <s-box padding="base" paddingBlockEnd="none">
        <s-stack gap="base">
          <s-text size="small" tone="subdued">
            数量を入力してください（{Number(editor?.min ?? 0)}〜{Number(editor?.max ?? 999999)}）
          </s-text>
          <s-text-field
            label="数量"
            value={text}
            inputMode="numeric"
            onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
            onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
          />
          {editor?.onRemove ? (
            <s-stack gap="base">
              <s-divider />
              <s-box padding="none">
                <s-button
                  tone="critical"
                  onClick={() => {
                    const rm = editor.onRemove;
                    closeEditor();
                    rm?.();
                  }}
                >
                  削除
                </s-button>
              </s-box>
              <s-divider />
            </s-stack>
          ) : null}
          <s-box padding="none">
            <s-button onClick={closeEditor}>戻る</s-button>
          </s-box>
        </s-stack>
      </s-box>
      <s-button
        slot="primary-action"
        tone="success"
        onClick={() => {
          const raw = String(text ?? "").trim();
          const min = Number.isFinite(Number(editor?.min)) ? Number(editor.min) : 0;
          const n = clamp(raw === "" ? min : raw);
          const onSet = editor?.onSetQty;
          closeEditor();
          onSet?.(Number.isFinite(n) ? n : min);
        }}
      >
        {editor?.primaryLabel || "OK"}
      </s-button>
    </s-modal>
  );

  return (
    <InboundQtyEditorContext.Provider value={openQtyEditor}>
      {children}
      {host}
    </InboundQtyEditorContext.Provider>
  );
}
