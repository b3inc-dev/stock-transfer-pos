import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { AdminBlock } from "./admin-ui";
export function ReservationScopeAccess({ onError }: { onError: (message: string) => void }) {
  const bridge = useAppBridge();
  const [missingScopes, setMissingScopes] = useState<string[]>([]);
  const [scopeBusy, setScopeBusy] = useState(false);
  useEffect(() => { bridge.scopes.query().then(detail => setMissingScopes(["read_orders", "read_customers"].filter(scope => !detail.granted.includes(scope)))).catch(() => onError("取置に必要な権限を確認できません。画面を更新してください")); }, [bridge, onError]);
  const requestScopes = async () => {
    setScopeBusy(true); onError("");
    try {
      const response = await bridge.scopes.request(missingScopes);
      setMissingScopes(["read_orders", "read_customers"].filter(scope => !response.detail.granted.includes(scope)));
      if (response.result !== "granted-all") onError("権限が許可されませんでした。取置を利用するには顧客・注文の読み取りが必要です");
    } catch { onError("権限を更新できませんでした。アプリの承認状況を確認してください"); }
    finally { setScopeBusy(false); }
  };
  return <>
    {missingScopes.length ? <AdminBlock wide title="取置の利用権限" description="顧客と決済済み注文を照合するため、読み取り権限が必要です。" action={<button type="button" className="Admin-secondary" disabled={scopeBusy} onClick={requestScopes}>{scopeBusy ? "確認中…" : "権限を許可"}</button>}><p className="Admin-note">ストアの管理者が許可してください。</p></AdminBlock> : null}
  </>;
}
