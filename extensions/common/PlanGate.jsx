/**
 * POS のタイルの中身を、料金プランで使えるときだけ出す（posPlanGate.js でサーバーに聞く）。
 * 自社用（APP_MODE = "inhouse"）は聞かずにすぐ中身を出す。
 * 止めたときは見出し（何が起きたか）と本文（どうすればいいか）を出す（docs/UI_RULES.md 5章・11章）。
 */
import { useState, useEffect, useCallback } from "preact/hooks";
import { checkPosPlanAccess } from "./posPlanGate.js";
import { getAppMode } from "./appUrl.js";

/** モーダルを閉じる（各 Modal.jsx の dismissModal と同じ順で試す） */
function dismissPosModal(modalApi) {
  const S = globalThis?.shopify ?? {};
  const fns = [
    modalApi?.navigation?.dismiss,
    globalThis?.navigation?.dismiss,
    S?.navigation?.dismiss,
    S?.action?.dismissModal,
    S?.action?.dismiss,
  ];
  for (const fn of fns) {
    try {
      if (typeof fn === "function") {
        fn();
        return;
      }
    } catch {}
  }
}

export function PlanGate({ feature, heading, getModalApi, children }) {
  const inhouse = getAppMode() === "inhouse";
  const [state, setState] = useState(() => (inhouse ? { access: "allowed" } : { access: "checking" }));

  const runCheck = useCallback(async () => {
    setState({ access: "checking" });
    const result = await checkPosPlanAccess(feature);
    setState(result);
  }, [feature]);

  useEffect(() => {
    if (inhouse) return;
    runCheck();
  }, [inhouse, runCheck]);

  const onClose = useCallback(() => dismissPosModal(getModalApi?.()), [getModalApi]);

  if (state.access === "allowed") return children;

  if (state.access === "checking") {
    return (
      <s-page heading={heading}>
        <s-box padding="base">
          <s-text tone="subdued">料金プランを確認しています…</s-text>
        </s-box>
      </s-page>
    );
  }

  const failed = state.access === "plan_check_failed";
  return (
    <s-page heading={heading}>
      <s-box padding="base">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={failed ? "critical" : "warning"}>{failed ? "失敗" : "要確認"}</s-badge>
            <s-text type="strong">{state.heading}</s-text>
          </s-stack>
          <s-text>{state.message}</s-text>
          <s-stack direction="inline" gap="small">
            <s-button kind="primary" onClick={runCheck} onPress={runCheck}>
              もう一度確認
            </s-button>
            <s-button kind="secondary" onClick={onClose} onPress={onClose}>
              閉じる
            </s-button>
          </s-stack>
        </s-stack>
      </s-box>
    </s-page>
  );
}
