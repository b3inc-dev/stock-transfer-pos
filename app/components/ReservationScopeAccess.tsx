import { useCallback, useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { AdminBlock } from "./admin-ui";
const required = ["read_orders", "read_customers"];
const missingFrom = (granted: string[]) => required.filter(scope => !granted.includes(scope) && !granted.includes(scope.replace("read_", "write_")));
export function ReservationScopeAccess({ onError }: { onError: (message: string) => void }) {
  const bridge = useAppBridge();
  const [missingScopes, setMissingScopes] = useState<string[]>([]);
  const [status, setStatus] = useState<"checking" | "ready" | "failed">("checking");
  const [scopeBusy, setScopeBusy] = useState(false);
  const checkScopes = useCallback(async () => {
    setStatus("checking"); onError("");
    try { const detail = await bridge.scopes.query(); setMissingScopes(missingFrom(detail.granted)); setStatus("ready"); }
    catch { setStatus("failed"); onError("取置に必要な権限を確認できません。「再確認」を押してもう一度お試しください"); }
  }, [bridge, onError]);
  useEffect(() => { void checkScopes(); }, [checkScopes]);
  const requestScopes = async () => {
    setScopeBusy(true); onError("");
    try {
      const response = await bridge.scopes.request(missingScopes);
      const missing = missingFrom(response.detail.granted);
      setMissingScopes(missing);
      if (missing.length) onError("権限が許可されませんでした。ストア管理者が顧客・注文の読み取りを許可してください");
    } catch { onError("権限を更新できませんでした。アプリの承認状況を確認してください"); }
    finally { setScopeBusy(false); }
  };
  return <AdminBlock wide title="取置の読み取り権限"
    description={status === "checking" ? "権限を確認しています。" : status === "failed" ? "読み取り権限を確認できませんでした。" : missingScopes.length ? "初回は、ストア管理者が顧客と決済済み注文の読み取りを許可してください。" : "顧客・注文の読み取りは許可されています。"}
    action={status === "failed" ? <button type="button" className="Admin-secondary" onClick={() => void checkScopes()}>再確認</button> : status === "ready" && missingScopes.length ? <button type="button" className="Admin-secondary" disabled={scopeBusy} onClick={requestScopes}>{scopeBusy ? "確認中…" : "権限を許可"}</button> : undefined}>
    <p className="Admin-note">承認後はPOSの取置タイルから受付できます。</p>
  </AdminBlock>;
}
