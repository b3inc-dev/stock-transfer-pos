import { useEffect, useState } from "react";
import { Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { getRequestPolicy, saveRequestPolicy } from "../utils/outbound-requests.server";
import { AdminBlock, BackAction, SaveBar, StatusBanner, SuccessToast, SecondaryLink } from "../components/admin-ui";
import { OutboundRequestNav } from "../components/outbound-request-ui";
import { requestReturnTo } from "../utils/outbound-request-view";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await outboundAdmin(request);
  return { ...await getRequestPolicy(session.shop), returnTo: requestReturnTo(new URL(request.url).searchParams.get("returnTo")) };
}
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await outboundAdmin(request), form = await request.formData();
  try {
    const current = await getRequestPolicy(session.shop);
    await saveRequestPolicy(session.shop, Number(form.get("version")), { ...current.policy, allowUnder: form.get("allowUnder") === "1", allowOver: form.get("allowOver") === "1", allowExtra: form.get("allowExtra") === "1", underReason: form.get("underReason"), overReason: form.get("overReason"), extraReason: form.get("extraReason") });
    return data({ ok: true, error: "", saved: Date.now() });
  } catch (error) { return data({ ok: false, error: error instanceof Error ? error.message : "保存できませんでした", saved: 0 }, { status: 409 }); }
}
export default function RequestSettings() {
  const loaded = useLoaderData<typeof loader>(), result = useActionData<typeof action>(), busy = useNavigation().state !== "idle";
  const [{ policy, version }, setSaved] = useState(loaded);
  useEffect(() => { if (result?.ok) setSaved(loaded); }, [loaded, result]);
  return <s-page heading="出庫依頼の設定"><BackAction to={loaded.returnTo} label="出庫依頼へ戻る" /><div className="Admin-body">
    <OutboundRequestNav selected="settings" returnTo={loaded.returnTo} />
    <SuccessToast message={result?.ok ? "保存しました" : null} trigger={result} />
    {result?.error ? <StatusBanner tone="critical" heading="保存できませんでした">{result.error}</StatusBanner> : null}
    <Form method="post"><input type="hidden" name="version" value={version} />
      <fieldset className="Outreq-form-fieldset" disabled={busy}>
        {([ ["allowUnder", "underReason", "過少出庫"], ["allowOver", "overReason", "過剰出庫"], ["allowExtra", "extraReason", "依頼にないSKUの追加"] ] as const).map(([allowed, reason, label]) => <AdminBlock key={allowed} title={label} description="出庫依頼にのみ適用します。確定時には最新の設定で再確認します。">
          <label><input name={allowed} type="checkbox" value="1" defaultChecked={policy[allowed]} />許可する</label>
          <label>理由入力<select name={reason} defaultValue={policy[reason]}><option value="none">不要</option><option value="optional">任意</option><option value="required">必須</option></select></label>
        </AdminBlock>)}
        <AdminBlock title="依頼書の編集" description="用紙幅・書式・コード・プレビューはレシート編集へ移動しました。"><SecondaryLink to="/app/receipts?tab=outbound_request">出庫依頼書を編集</SecondaryLink></AdminBlock>
      </fieldset>
      <SaveBar status={result?.saved} failed={Boolean(result?.error) && !busy} />
    </Form>
  </div></s-page>;
}
