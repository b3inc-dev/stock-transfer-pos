import { useId } from "react";
import { Form } from "react-router";
import { GuardedLink, PrimaryButton } from "./admin-ui";
import { REQUEST_LIST_PATH, requestChildUrl } from "../utils/outbound-request-view";

export function OutboundRequestNav({ selected, returnTo = REQUEST_LIST_PATH }: { selected: "list" | "create" | "settings"; returnTo?: string }) {
  const items = [
    { key: "list", label: "依頼一覧", path: returnTo },
    { key: "create", label: "作成", path: requestChildUrl(REQUEST_LIST_PATH + "/new", returnTo) },
    { key: "settings", label: "設定", path: requestChildUrl(REQUEST_LIST_PATH + "/settings", returnTo) },
  ];
  return <><style>{requestCss}</style><nav className="Outreq-tabs" aria-label="出庫依頼のメニュー">
    {items.map(item => <GuardedLink key={item.key} to={item.path} className={selected === item.key ? "is-active" : undefined} aria-current={selected === item.key ? "page" : undefined}>{item.label}</GuardedLink>)}
  </nav></>;
}
export function PublishRequest({ number, origin, destination, quantity, version, busy }: { number: string; origin: string; destination: string; quantity: number; version: number; busy: boolean }) {
  const id = "request-publish-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hide = () => (document.getElementById(id) as (HTMLElement & { hideOverlay?: () => void }) | null)?.hideOverlay?.();
  return <>
    <s-button variant="primary" commandFor={id} command="--show" disabled={busy || undefined}>{busy ? "処理中…" : "店舗へ依頼する"}</s-button>
    <s-modal id={id} heading="店舗へ依頼しますか？">
      <Form method="post" onSubmit={hide}>
        <input type="hidden" name="command" value="publish" /><input type="hidden" name="version" value={version} /><input type="hidden" name="confirmed" value="yes" />
        <p className="Admin-confirm-text">{number}<br />{origin} → {destination}<br />合計 {quantity.toLocaleString("ja-JP")}点</p>
        <p className="Admin-note">出庫元のPOSに依頼を表示します。この操作では在庫は変わりません。</p>
        <div className="Admin-confirm-actions"><button type="button" className="Admin-secondary" onClick={hide}>やめる</button><PrimaryButton disabled={busy}>{busy ? "処理中…" : "店舗へ依頼する"}</PrimaryButton></div>
      </Form>
    </s-modal>
  </>;
}
const requestCss = [
  ".Outreq-tabs {display:flex;gap:8px;padding:0 0 8px;border-bottom:1px solid #e1e3e5;margin-bottom:24px;overflow-x:auto;flex-wrap:nowrap;}",
  ".Admin-body .Outreq-tabs a:not(.Admin-primary):not(.Admin-secondary) {flex:0 0 auto;border-radius:8px;padding:4px 12px;color:inherit;text-decoration:none;font-size:14px;line-height:20px;min-height:28px;box-sizing:border-box;font-weight:500;}",
  ".Admin-body .Outreq-tabs a.is-active:not(.Admin-primary):not(.Admin-secondary) {background:#e5e7eb;font-weight:600;}",
  ".Outreq-form-fieldset {border:0;margin:0;padding:0;min-width:0;}",
  ".Outreq-receipt {padding:12px 0;border-bottom:1px solid #e1e3e5;}",
  ".Outreq-split {display:grid;grid-template-columns:minmax(260px,2fr) minmax(0,3fr);gap:24px;align-items:start;}",
  ".Outreq-split .Admin-form a.Admin-primary {background:#005bd3;color:#fff;box-shadow:inset 0 -1px 0 #004299;}",
  ".Outreq-split .Admin-form a.Admin-primary:hover {background:#004299;}",
  ".Outreq-split section,.Outreq-split aside,.Outreq-split main {min-width:0;}",
  ".Outreq-heading {margin:0 0 4px;font-size:14px;font-weight:600;}",
  ".Outreq-intro {margin:0 0 16px;}",
  ".Outreq-fields {display:grid;grid-template-columns:minmax(0,1fr);gap:16px;}",
  ".Outreq-fields label {display:grid;gap:6px;min-width:0;overflow-wrap:anywhere;}",
  ".Outreq-fields .Admin-pick-row {display:flex;}",
  ".Outreq-fields input:not([type=checkbox]):not([type=radio]),.Outreq-fields select,.Outreq-fields textarea {width:100%;box-sizing:border-box;min-width:0;}",
  ".Outreq-fields fieldset {border:0;padding:0;margin:0;}",
  ".Outreq-fields legend {font-weight:600;margin-bottom:8px;}",
  ".Outreq-sort {display:flex;flex-direction:column;gap:8px;border:0;padding:0;}",
  ".Outreq-sort label {display:flex;align-items:center;gap:8px;font-weight:400;}",
  ".Admin-body a.Outreq-row:not(.Admin-primary):not(.Admin-secondary) {display:block;color:inherit;text-decoration:none;padding:16px 8px;border-bottom:1px solid #e1e3e5;overflow-wrap:anywhere;}",
  ".Outreq-row:hover {background:#f7f7f7;}",
  ".Outreq-row p {margin:4px 0;}",
  ".Outreq-row-top,.Outreq-row-bottom {display:flex;justify-content:space-between;gap:12px;align-items:start;}",
  ".Outreq-row-top strong {min-width:0;overflow-wrap:anywhere;}",
  ".Outreq-row-date {white-space:nowrap;flex-shrink:0;}",
  ".Outreq-row-bottom {align-items:center;}",
  ".Outreq-count {white-space:nowrap;font-variant-numeric:tabular-nums;}",
  ".Outreq-pager {display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;}",
  ".Outreq-candidates {max-height:280px;overflow-y:auto;}",
  ".Outreq-candidate {display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #e1e3e5;}",
  ".Outreq-candidate p {margin:4px 0;overflow-wrap:anywhere;}",
  ".Outreq-detail {display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,320px);gap:24px;align-items:start;}",
  ".Outreq-detail section,.Outreq-detail aside,.Outreq-detail main {min-width:0;}",
  ".Outreq-summary {margin:0;display:grid;gap:12px;}",
  ".Outreq-summary dt {color:#616161;font-size:13px;}",
  ".Outreq-summary dd {margin:4px 0 0;overflow-wrap:anywhere;}",
  ".Outreq-actions {display:flex;flex-wrap:wrap;gap:8px;align-items:center;}",
  ".Outreq-actions .Admin-secondary {margin:0;}",
  ".Outreq-number {font-variant-numeric:tabular-nums;text-align:right;width:100%;box-sizing:border-box;}",
  ".Outreq-help {white-space:pre-wrap;overflow-wrap:anywhere;}",
  "@media(max-width:767px) {.Outreq-split,.Outreq-detail {grid-template-columns:minmax(0,1fr);}.Outreq-detail aside {order:-1;}.Admin-body .Outreq-tabs a:not(.Admin-primary):not(.Admin-secondary) {min-height:44px;display:flex;align-items:center;}.Outreq-row-top {flex-wrap:wrap;}.Outreq-row-date {white-space:normal;}.Outreq-candidate {align-items:start;}}",
].join("\n");
