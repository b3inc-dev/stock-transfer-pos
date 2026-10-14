/**
 * 入庫の共有ダイアログホスト（出庫 modalDialog.jsx / DialogHost と同型）
 *
 * 重要:
 * - Host 要素は <s-page> の兄弟として置く（Provider で s-page を包んで末尾に modal を足さない）
 * - Context は open 関数のみを配り、qtyEditorHost / confirmReceiveHost を Extension 直下に置く
 * - Host は毎描画の新規 function component にしない（remote-dom が毎回 remount する）
 * - s-modal ノード自体を effect cleanup で null→再生成しない（command="--show" と競合して e.nodeType）
 *
 * #29/#30 の pageOverlay + setChromeRender(effect deps) は、リスト押下や明細ロードのたびに
 * modal を破棄・再生成し、remote-dom が `undefined is not an object (evaluating 'e.nodeType')`
 * になり得た。数量・確定は常に1つ・page 外に固定し、中身だけ state で更新する。
 */
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";

export const INBOUND_SHARED_QTY_MODAL_ID = "inbound-shared-qty-modal";
export const CONFIRM_RECEIVE_MODAL_ID = "CONFIRM_RECEIVE_MODAL_ID";

const CONFIRM_MODAL_ONE_LINE_STYLE = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};
const DIFF_PREVIEW_LIMIT_DEFAULT = 1;

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

/**
 * @typedef {{
 *   active?: boolean,
 *   plannedTotal?: number,
 *   receiveTotal?: number,
 *   extrasQtyTotal?: number,
 *   overQtyTotal?: number,
 *   shortageQtyTotal?: number,
 *   hasWarning?: boolean,
 *   shortageRows?: Array<{ shipmentLineItemId?: string, title?: string, shortageQty?: number }>,
 *   extras?: Array<{ key?: string, title?: string, receiveQty?: number }>,
 *   overRows?: Array<{ shipmentLineItemId?: string, title?: string, overQty?: number }>,
 *   ackWarning?: boolean,
 *   setAckWarning?: (v: boolean) => void,
 *   canConfirm?: boolean,
 *   warningReady?: boolean,
 *   receiveSubmitting?: boolean,
 *   receiveConfirm?: (opts: { finalize: boolean }) => Promise<boolean>,
 *   onBack?: () => void,
 *   diffPreviewLimit?: number,
 * }} ConfirmReceiveModel
 */

export function useInboundQtyEditor() {
  return useContext(InboundQtyEditorContext);
}

/**
 * 出庫の useUnifiedDialog 相当。state + host 要素を返し、Extension が
 * `<> <Provider><s-page/></Provider> {qtyEditorHost} {confirmReceiveHost} </>` で組み立てる。
 */
export function useInboundQtyEditorController() {
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

  // Element (not a fresh function component each render) so remote-dom keeps one stable modal node.
  const qtyEditorHost = (
    <s-modal ref={modalRef} id={INBOUND_SHARED_QTY_MODAL_ID} heading={editor?.title || "数量"}>
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

  return {
    openQtyEditor,
    QtyEditorProvider: InboundQtyEditorContext.Provider,
    qtyEditorHost,
  };
}

/**
 * 確定モーダルを s-page 外に常設。model の中身だけ更新し、modal ノードは破棄しない。
 * （#29/#30 の setPageOverlay + effect cleanup が明細ロード中に remount して e.nodeType になっていた）
 */
export function useInboundConfirmReceiveController() {
  const [model, setModel] = useState(/** @type {ConfirmReceiveModel | null} */ (null));
  const modelRef = useRef(model);
  modelRef.current = model;

  const setConfirmReceive = useCallback((next) => {
    setModel(next && typeof next === "object" ? next : null);
  }, []);

  const hideConfirmModal = useCallback(() => {
    try {
      document.querySelector(`#${CONFIRM_RECEIVE_MODAL_ID}`)?.hide?.();
    } catch (_) {}
  }, []);

  const m = model;
  const active = !!(m && m.active);
  const plannedTotal = Number(m?.plannedTotal || 0);
  const receiveTotal = Number(m?.receiveTotal || 0);
  const extrasQtyTotal = Number(m?.extrasQtyTotal || 0);
  const overQtyTotal = Number(m?.overQtyTotal || 0);
  const shortageQtyTotal = Number(m?.shortageQtyTotal || 0);
  const hasWarning = !!m?.hasWarning;
  const shortageRows = Array.isArray(m?.shortageRows) ? m.shortageRows : [];
  const extras = Array.isArray(m?.extras) ? m.extras : [];
  const overRows = Array.isArray(m?.overRows) ? m.overRows : [];
  const ackWarning = !!m?.ackWarning;
  const canConfirm = !!m?.canConfirm;
  const warningReady = !!m?.warningReady;
  const receiveSubmitting = !!m?.receiveSubmitting;
  const diffPreviewLimit = Number.isFinite(Number(m?.diffPreviewLimit))
    ? Number(m.diffPreviewLimit)
    : DIFF_PREVIEW_LIMIT_DEFAULT;

  const confirmReceiveHost = (
    <s-modal id={CONFIRM_RECEIVE_MODAL_ID} heading="入庫を確定しますか？">
      {active ? (
        <s-box padding="none" style={{ paddingInline: 8, paddingBlockStart: 8, paddingBlockEnd: 0, maxHeight: "60vh", overflowY: "auto" }}>
          <s-stack gap="small">
            <s-stack gap="extra-tight">
              <s-text size="small" tone="subdued">予定 {plannedTotal} / 入庫 {receiveTotal}</s-text>
              <s-text size="small" tone="subdued">予定外 {extrasQtyTotal} / 超過 {overQtyTotal} / 不足 {shortageQtyTotal}</s-text>
              {hasWarning ? <s-text size="small" tone="critical">※ 予定外/超過/不足 があります。</s-text> : null}
            </s-stack>
            {shortageRows.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical">不足（{shortageRows.length}件）</s-text>
                {shortageRows.slice(0, diffPreviewLimit).map((x) => (
                  <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={CONFIRM_MODAL_ONE_LINE_STYLE}>
                    ・{x.title}：-{Number(x.shortageQty || 0)}
                  </s-text>
                ))}
                {shortageRows.length > diffPreviewLimit ? (
                  <s-text size="small" tone="subdued">…他 {shortageRows.length - diffPreviewLimit} 件</s-text>
                ) : null}
              </s-stack>
            ) : null}
            {extras.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical">予定外（{extras.length}件）</s-text>
                {extras.slice(0, diffPreviewLimit).map((x) => (
                  <s-text key={x.key} size="small" tone="subdued" style={CONFIRM_MODAL_ONE_LINE_STYLE}>
                    ・{x.title}：{Number(x.receiveQty || 0)}
                  </s-text>
                ))}
                {extras.length > diffPreviewLimit ? (
                  <s-text size="small" tone="subdued">…他 {extras.length - diffPreviewLimit} 件</s-text>
                ) : null}
              </s-stack>
            ) : null}
            {overRows.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical">超過（{overRows.length}件）</s-text>
                {overRows.slice(0, diffPreviewLimit).map((x) => (
                  <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={CONFIRM_MODAL_ONE_LINE_STYLE}>
                    ・{x.title}：+{Number(x.overQty || 0)}
                  </s-text>
                ))}
                {overRows.length > diffPreviewLimit ? (
                  <s-text size="small" tone="subdued">…他 {overRows.length - diffPreviewLimit} 件</s-text>
                ) : null}
              </s-stack>
            ) : null}
            {hasWarning ? (
              <>
                <s-divider />
                <s-stack gap="small">
                  <s-text size="small" tone="critical">予定外/超過/不足があります。「確認しました」を押してから確定してください。</s-text>
                  <s-button
                    kind="secondary"
                    size="small"
                    onClick={() => modelRef.current?.setAckWarning?.(true)}
                    disabled={ackWarning}
                  >
                    {ackWarning ? "確認済み" : "確認しました"}
                  </s-button>
                </s-stack>
              </>
            ) : null}
            <s-divider />
            <s-box>
              <s-button command="--hide" commandFor={CONFIRM_RECEIVE_MODAL_ID}>戻る</s-button>
            </s-box>
          </s-stack>
        </s-box>
      ) : null}
      <s-button
        slot="secondary-actions"
        kind="secondary"
        tone="critical"
        disabled={!active || !canConfirm || !warningReady || receiveSubmitting}
        onClick={async () => {
          const fn = modelRef.current?.receiveConfirm;
          const ok = await fn?.({ finalize: false });
          if (ok) hideConfirmModal();
        }}
        onPress={async () => {
          const fn = modelRef.current?.receiveConfirm;
          const ok = await fn?.({ finalize: false });
          if (ok) hideConfirmModal();
        }}
      >
        一部入庫（一時保存）
      </s-button>
      <s-button
        slot="primary-action"
        tone={hasWarning ? "critical" : "success"}
        disabled={!active || !canConfirm || !warningReady || receiveSubmitting}
        onClick={async () => {
          const cur = modelRef.current;
          const ok = await cur?.receiveConfirm?.({ finalize: true });
          if (ok) {
            hideConfirmModal();
            cur?.onBack?.();
          }
        }}
        onPress={async () => {
          const cur = modelRef.current;
          const ok = await cur?.receiveConfirm?.({ finalize: true });
          if (ok) {
            hideConfirmModal();
            cur?.onBack?.();
          }
        }}
      >
        確定する
      </s-button>
    </s-modal>
  );

  return {
    setConfirmReceive,
    confirmReceiveHost,
  };
}
