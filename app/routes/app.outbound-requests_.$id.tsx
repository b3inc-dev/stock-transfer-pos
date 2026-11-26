import { Suspense } from "react";
import { Await, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { changeRequest, getRequest, requestError, requestTransferSummary } from "../utils/outbound-requests.server";
import { AdminBlock, BackAction, ConfirmAction, SecondaryLink, StateBadge, StatusBanner, SuccessToast } from "../components/admin-ui";
import { OutboundRequestNav, PublishRequest } from "../components/outbound-request-ui";
import { REQUEST_LIST_PATH, requestReturnTo, requestChildUrl, requestDate } from "../utils/outbound-request-view";
import { OUTBOUND_REQUEST_LABELS, outboundRequestTone } from "../../extensions/common/outboundRequests.js";

const receiptStatusLabels: Record<string, string> = { TRANSFERRED: "受領処理済み", IN_PROGRESS: "処理中", READY_TO_SHIP: "配送準備完了", DRAFT: "下書き", CANCELED: "取消済み" };
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await outboundAdmin(request);
  const row = await getRequest(session.shop, params.id || "");
  const events = await db.outboundRequestEvent.findMany({ where: { requestId: row.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const url = new URL(request.url);
  return { row, receipts: requestTransferSummary(row, admin), events: events as { id: string; actor: string; action: string; createdAt: Date }[], returnTo: requestReturnTo(url.searchParams.get("returnTo")), saved: url.searchParams.get("saved") === "1" };
}
export async function action({ request, params }: ActionFunctionArgs) {
  const { session, actor } = await outboundAdmin(request), form = await request.formData();
  try {
    const row = await getRequest(session.shop, params.id || "");
    if (row.version !== Number(form.get("version"))) throw requestError("依頼が更新されました。読み直してください");
    const command = form.get("command");
    if (command === "release" && row.status === "working") await changeRequest(row, actor, "管理側で作業を中止", { status: "requested", owner: null, claimKey: null });
    else if (command === "cancel" && ["draft", "requested"].includes(row.status)) await changeRequest(row, actor, "依頼を取消", { status: "cancelled" });
    else if (command === "publish" && row.status === "draft" && form.get("confirmed") === "yes") await changeRequest(row, actor, "依頼を発行", { status: "requested" });
    else throw requestError(command === "publish" && row.status === "draft" ? "内容を確認してから店舗へ依頼してください" : "出庫処理中・出庫済みの依頼は変更できません");
    return data({ ok: true, error: "", command: String(command), saved: Date.now() });
  } catch (error) { return data({ ok: false, error: error instanceof Error ? error.message : "操作できませんでした", command: "", saved: 0 }, { status: 409 }); }
}
export default function RequestDetail() {
  const { row, events, receipts, returnTo, saved } = useLoaderData<typeof loader>(), result = useActionData<typeof action>(), busy = useNavigation().state !== "idle";
  const actual = new Map(row.actualLines.map(line => [line.inventoryItemId, line]));
  const allLines = [...row.lines, ...row.actualLines.filter(line => !row.lines.some(item => item.inventoryItemId === line.inventoryItemId)).map(line => ({ ...line, quantity: 0 }))];
  const quantity = row.lines.reduce((sum, line) => sum + line.quantity, 0);
  const message = result?.ok ? result.command === "publish" ? "店舗へ依頼しました" : result.command === "cancel" ? "依頼を取り消しました" : "作業を中止しました" : saved ? "保存しました" : null;
  const error = result?.error || row.error;
  const notice = row.status === "uncertain" ? "出庫結果を確認する必要があります。POSで同じ依頼を開き、結果を確認してください。" : row.status === "retryable" ? "出庫が途中で止まっています。POSで同じ依頼を開き、未完了分から再開してください。" : "";
  return <s-page heading="出庫依頼の詳細"><BackAction to={returnTo} label="出庫依頼へ戻る" /><div className="Admin-body">
    <OutboundRequestNav selected="list" returnTo={returnTo} />
    <SuccessToast message={message} trigger={result?.ok ? result : saved ? row.id + ":saved" : null} />
    {error || notice ? <StatusBanner tone={result?.error ? "critical" : "warning"} heading={result?.error ? "操作できませんでした" : "内容を確認してください"}>{error}{error && notice ? <br /> : null}{notice}</StatusBanner> : null}
    <div className="Outreq-detail">
      <main>
        <AdminBlock wide title={row.number} description={row.originName + " → " + row.destinationName}>
          <p className="Admin-note">{row.lines.length}種類・依頼合計{quantity.toLocaleString("ja-JP")}点</p>
          <div className="History-scroll"><table className="History-table"><thead><tr><th>商品・SKU・JAN</th><th className="History-num">依頼</th><th className="History-num">{row.status === "completed" ? "出庫" : "検品"}</th><th className="History-num">差分</th><th>理由</th></tr></thead><tbody>{allLines.map(line => {
            const inspected = actual.get(line.inventoryItemId), known = Boolean(inspected) || row.status === "completed", delta = (inspected?.quantity || 0) - line.quantity;
            return <tr key={line.inventoryItemId}><td data-label="商品">{line.title}<p className="Admin-note">SKU: {line.sku || "—"}<br />JAN: {line.barcode || "—"}</p></td><td className="History-num" data-label="依頼">{line.quantity.toLocaleString("ja-JP")}</td><td className="History-num" data-label={row.status === "completed" ? "出庫" : "検品"}>{known ? (inspected?.quantity || 0).toLocaleString("ja-JP") : "—"}</td><td className="History-num" data-label="差分">{known ? (delta > 0 ? "+" : "") + delta : "—"}</td><td data-label="理由">{inspected?.reason || "—"}</td></tr>;
          })}</tbody></table></div>
          {!row.actualLines.length && row.status !== "completed" ? <p className="Admin-note">検品結果はまだ保存されていません。</p> : null}
          {row.note ? <p className="Outreq-help">備考: {row.note}</p> : null}
        </AdminBlock>
      </main>
      <aside>
        <AdminBlock wide title="依頼の状況">
          <StateBadge tone={outboundRequestTone(row.status)} label={OUTBOUND_REQUEST_LABELS[row.status as keyof typeof OUTBOUND_REQUEST_LABELS] || "要確認"} />
          <dl className="Outreq-summary">
            <div><dt>出庫元ロケーション</dt><dd>{row.originName}</dd></div><div><dt>移動先ロケーション</dt><dd>{row.destinationName}</dd></div>
            <div><dt>希望出庫日</dt><dd>{requestDate(row.dueDate)}</dd></div><div><dt>作成日時</dt><dd>{requestDate(row.createdAt)}</dd></div>
            <div><dt>最終更新</dt><dd>{requestDate(row.updatedAt)}</dd></div><div><dt>作業担当</dt><dd>{row.owner ? "POSスタッフ " + row.owner : "未着手"}</dd></div>
          </dl>
        </AdminBlock>
        <AdminBlock wide title="操作">
          <div className="Outreq-actions">
            {row.status === "draft" ? <PublishRequest number={row.number} origin={row.originName} destination={row.destinationName} quantity={quantity} version={row.version} busy={busy} /> : null}
            {["draft", "requested", "working"].includes(row.status) && !busy ? <SecondaryLink to={requestChildUrl(REQUEST_LIST_PATH + "/new", returnTo, { id: row.id })}>{row.status === "working" ? "商品・数量を追加" : "編集"}</SecondaryLink> : null}
            {row.status === "working" ? <ConfirmAction label="作業を中止" heading="店舗の作業を中止しますか？" message="保存済み検品を残し、作業を取り直せる状態にします。" disabled={busy} fields={{ command: "release", version: String(row.version) }} trigger="secondary" /> : null}
            {["draft", "requested"].includes(row.status) ? <ConfirmAction label="依頼を取消" heading="依頼を取り消しますか？" message="店舗から出庫を開始できなくなります。在庫は変更しません。" disabled={busy} fields={{ command: "cancel", version: String(row.version) }} trigger="secondary" /> : null}
          </div>
          <p className="Admin-note">{row.status === "draft" ? "内容を確認してから店舗へ依頼してください。発行では在庫は変わりません。" : row.status === "working" ? "商品・数量を追加するとPOSで再確認が必要です。" : ["processing", "uncertain", "retryable"].includes(row.status) ? "POSで同じ依頼を確認してください。この画面では編集・再出庫は行いません。" : row.status === "completed" ? "出庫は完了しています。受領状況は下の欄で確認できます。" : row.status === "cancelled" ? "取り消された依頼です。" : "店舗のPOSで依頼を確認して出庫します。"}</p>
        </AdminBlock>
      </aside>
    </div>
    <AdminBlock wide title="発送・受領状況" description="出庫完了と移動先での受領は別の状態です。受領操作は既存の入庫で行います。">
      {row.execution?.tracking ? <p className="Admin-note">配送: {[row.execution.tracking.company, row.execution.tracking.trackingNumber].filter(Boolean).join(" / ") || "—"}</p> : null}
      <Suspense fallback={<p role="status">読み込んでいます。</p>}>
        <Await resolve={receipts} errorElement={<p role="status">受領状況を確認できません。既存の入出庫履歴で確認してください。</p>}>
          {items => items.length ? items.map(({ id, status, quantities }, index) => <div key={id} className="Outreq-receipt">
            <p><strong>出庫 {index + 1}</strong>・{receiptStatusLabels[status] ?? "要確認"}</p>
            <p>{quantities ? <>配送明細 {quantities.total}点 ／ 受入 {quantities.accepted}点 ／ 拒否 {quantities.rejected}点 ／ 未処理 {quantities.pending}点{quantities.canceled > 0 ? " ／ 取消 " + quantities.canceled + "点" : ""}</> : "受領数量を確認できません"}</p>
            <SecondaryLink small to={"/app/history/" + encodeURIComponent(id)}>入出庫履歴を開く</SecondaryLink>
          </div>) : <p className="Admin-note">発送の記録はまだありません。</p>}
        </Await>
      </Suspense>
    </AdminBlock>
    <AdminBlock wide title="対応履歴">
      {events.length ? <div className="History-scroll"><table className="History-table"><thead><tr><th>日時</th><th>内容</th><th>担当</th></tr></thead><tbody>{events.map(event => <tr key={event.id}><td className="History-keep" data-label="日時">{requestDate(event.createdAt)}</td><td data-label="内容">{event.action}</td><td data-label="担当">{event.actor}</td></tr>)}</tbody></table></div> : <p className="Admin-note">対応履歴はありません。</p>}
    </AdminBlock>
  </div></s-page>;
}
