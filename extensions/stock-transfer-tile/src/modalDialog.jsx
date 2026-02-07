import { useRef, useState, useEffect } from "preact/hooks";
import { readValue } from "./modalHelpers.js";

const DIALOG_KIND = {
  ALERT: "ALERT",
  CONFIRM: "CONFIRM",
  INPUT: "INPUT",
};

export function useUnifiedDialog() {
  const modalRef = useRef(null);
  const overlayOpenRef = useRef(false);

  const [dlg, setDlg] = useState({
    isVisible: false,
    kind: DIALOG_KIND.ALERT,
    type: "default",
    title: "",
    content: "",
    actionText: "OK",
    secondaryActionText: "キャンセル",
    showSecondaryAction: false,
    inputLabel: "",
    inputValue: "",
    inputPlaceholder: "",
    _resolve: null,
  });

  const openOverlay = () => {
    if (overlayOpenRef.current) return;
    try {
      modalRef.current?.showOverlay?.();
    } catch {}
    overlayOpenRef.current = true;
  };

  const closeOverlay = () => {
    if (!overlayOpenRef.current) return;
    try {
      modalRef.current?.hideOverlay?.();
    } catch {}
    overlayOpenRef.current = false;
  };

  const close = () => {
    setDlg((d) => ({ ...d, isVisible: false, _resolve: null }));
  };

  const alert = ({ type = "default", title, content, message, actionText = "OK" }) =>
    new Promise((resolve) => {
      setDlg({
        isVisible: true,
        kind: DIALOG_KIND.ALERT,
        type,
        title: title ?? "",
        content: (content ?? message ?? "") ?? "",
        actionText,
        secondaryActionText: "",
        showSecondaryAction: false,
        inputLabel: "",
        inputValue: "",
        inputPlaceholder: "",
        _resolve: resolve,
      });
    });

  const confirm = ({
    type = "default",
    title,
    content,
    actionText = "OK",
    secondaryActionText = "キャンセル",
  }) =>
    new Promise((resolve) => {
      setDlg({
        isVisible: true,
        kind: DIALOG_KIND.CONFIRM,
        type,
        title: title ?? "",
        content: content ?? "",
        actionText,
        secondaryActionText,
        showSecondaryAction: true,
        inputLabel: "",
        inputValue: "",
        inputPlaceholder: "",
        _resolve: resolve,
      });
    });

  const input = ({
    type = "default",
    title,
    content,
    actionText = "確定",
    secondaryActionText = "キャンセル",
    inputLabel = "数量",
    inputValue = "",
    inputPlaceholder = "",
  }) =>
    new Promise((resolve) => {
      setDlg({
        isVisible: true,
        kind: DIALOG_KIND.INPUT,
        type,
        title: title ?? "",
        content: content ?? "",
        actionText,
        secondaryActionText,
        showSecondaryAction: true,
        inputLabel,
        inputValue: String(inputValue ?? ""),
        inputPlaceholder,
        _resolve: resolve,
      });
    });

  useEffect(() => {
    if (dlg.isVisible) openOverlay();
    else closeOverlay();
  }, [dlg.isVisible]);

  const DialogHost = () => {
    const toneOk =
      dlg.type === "destructive" || dlg.type === "error" ? "critical" : "success";

    return (
      <s-modal ref={modalRef} heading={dlg.title || "確認"}>
        <s-box padding="base">
          <s-stack gap="base">
            {dlg.content ? (
              <s-text tone={dlg.type === "error" ? "critical" : "subdued"}>
                {dlg.content}
              </s-text>
            ) : null}

            {dlg.kind === DIALOG_KIND.INPUT ? (
              <s-text-field
                label={dlg.inputLabel || "入力"}
                value={dlg.inputValue}
                placeholder={dlg.inputPlaceholder}
                onInput={(v) =>
                  setDlg((d) => ({ ...d, inputValue: readValue(v) }))
                }
                onChange={(v) =>
                  setDlg((d) => ({ ...d, inputValue: readValue(v) }))
                }
              />
            ) : null}
          </s-stack>
        </s-box>

        {dlg.showSecondaryAction ? (
          <s-button
            slot="secondary-actions"
            onClick={() => {
              const r = dlg._resolve;
              const kind = dlg.kind;
              close();
              if (kind === DIALOG_KIND.CONFIRM) r?.(false);
              if (kind === DIALOG_KIND.INPUT) r?.(null);
            }}
          >
            {dlg.secondaryActionText || "キャンセル"}
          </s-button>
        ) : null}

        <s-button
          slot="primary-action"
          tone={toneOk}
          onClick={() => {
            const r = dlg._resolve;
            const kind = dlg.kind;
            const value = kind === DIALOG_KIND.INPUT ? dlg.inputValue : true;
            close();
            if (kind === DIALOG_KIND.ALERT) r?.(true);
            if (kind === DIALOG_KIND.CONFIRM) r?.(true);
            if (kind === DIALOG_KIND.INPUT) r?.(value);
          }}
        >
          {dlg.actionText || "OK"}
        </s-button>
      </s-modal>
    );
  };

  return { alert, confirm, input, DialogHost };
}
