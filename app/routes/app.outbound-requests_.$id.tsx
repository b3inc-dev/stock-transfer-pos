import { Suspense } from "react";
import { Await, Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { changeRequest, getRequest, requestError, requestTransferSummary } from "../utils/outbound-requests.server";
import { AdminBlock, BackAction, ConfirmAction, SecondaryLink, StateBadge, StatusBanner } from "../components/admin-ui";
import { OUTBOUND_REQUEST_LABELS, outboundRequestTone } from "../../extensions/common/outboundRequests.js";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await outboundAdmin(request);
  const row = await getRequest(session.shop, params.id || "");
  const events = await db.outboundRequestEvent.findMany({ where: { requestId: row.id }, orderBy: { createdAt: "desc" }, take: 100 });
  return { row, receipts: requestTransferSummary(row, admin), events: events as { id: string; actor: string; action: string; createdAt: Date }[] };
}
export async function action({ request, params }: ActionFunctionArgs) {
  const { session, actor } = await outboundAdmin(request), form = await request.formData();
  try {
    const row = await getRequest(session.shop, params.id || "");
    if (row.version !== Number(form.get("version"))) throw requestError("依頼が更新されました。読み直してください");
    const command = form.get("command");
    if (command === "release" && row.status === "working") await changeRequest(row, actor, "管理側で作業を中止", { status: "requested", owner: null, claimKey: null });
    else if (command === "cancel" && ["draft", "requested"].includes(row.status)) await changeRequest(row, actor, "依頼を取消", { status: "cancelled" });
    else if (command === "publish" && row.status === "draft") await changeRequest(row, actor, "依頼を発行", { status: "requested" });
    else throw requestError("出庫処理中・出庫済みの依頼は変更できません");
    return data({ ok: true, error: "" });
  } catch (error) { return data({ ok: false, error: error instanceof Error ? error.message : "操作できませんでした" }, { status: 409 }); }
}
export default function RequestDetail() {
  const { row, events, receipts } = useLoaderData<typeof loader>(), result = useActionData<typeof action>(), busy = useNavigation().state !== "idle";
  const actual = new Map(row.actualLines.map(line => [line.inventoryItemId, line]));
  return <s-page heading="出庫依頼の詳細"><BackAction to="/app/outbound-requests" label="出庫依頼へ戻る" /><div className="Admin-body">
    {row.error || result?.error ? <StatusBanner tone="warning" heading="内容を確認してください">{row.error || result?.error}</StatusBanner> : null}
    <AdminBlock wide title={row.number} description={`${row.originName} → ${row.destinationName} / 希望日 ${row.dueDate || "指定なし"}`} action={["draft", "requested", "working"].includes(row.status) ? <SecondaryLink to={`/app/outbound-requests/new?id=${row.id}`}>編集・商品追加</SecondaryLink> : undefined}>
      <StateBadge tone={outboundRequestTone(row.status)} label={OUTBOUND_REQUEST_LABELS[row.status as keyof typeof OUTBOUND_REQUEST_LABELS]} /><p>{row.note}</p>
      <div className="History-scroll"><table className="History-table"><thead><tr><th>商品・SKU</th><th className="History-num">依頼</th><th className="History-num">{row.status === "completed" ? "出庫" : "検品"}</th><th>差分・理由</th></tr></thead><tbody>{[...row.lines, ...row.actualLines.filter(line => !row.lines.some(item => item.inventoryItemId === line.inventoryItemId)).map(line => ({ ...line, quantity: 0 }))].map(line => <tr key={line.inventoryItemId}><td data-label="商品">{line.title}<p className="Admin-note">{line.sku}</p></td><td className="History-num" data-label="依頼">{line.quantity}</td><td className="History-num" data-label="実数">{actual.get(line.inventoryItemId)?.quantity ?? 0}</td><td data-label="差分・理由">{(actual.get(line.inventoryItemId)?.quantity || 0) - line.quantity} / {actual.get(line.inventoryItemId)?.reason || "—"}</td></tr>)}</tbody></table></div>
      {row.status === "draft" ? <Form method="post"><input type="hidden" name="version" value={row.version} /><button className="Admin-secondary" name="command" value="publish" disabled={busy}>店舗へ依頼する</button></Form> : null}
      {row.status === "working" ? <ConfirmAction label="作業を中止" heading="店舗の作業を中止しますか？" message="保存済み検品を残し、作業を取り直せる状態にします。" disabled={busy} fields={{ command: "release", version: String(row.version) }} trigger="secondary" /> : null}
      {["draft", "requested"].includes(row.status) ? <ConfirmAction label="依頼を取消" heading="依頼を取り消しますか？" message="店舗から出庫を開始できなくなります。在庫は変更しません。" disabled={busy} fields={{ command: "cancel", version: String(row.version) }} trigger="secondary" /> : null}
    </AdminBlock>
    <AdminBlock wide title="出庫の記録" description="受領は既存の入庫で行います。">{row.execution?.chunks.map((chunk, index) => <p key={index}>分割 {index + 1}：Transfer {chunk.transferId || "未作成"} ／ Shipment {chunk.shipmentId || "未作成"}</p>)}</AdminBlock>
    <AdminBlock wide title="受領状況" description="Shopifyの最新状況を参照します。ここでは受領操作を行いません。"><Suspense fallback={<p role="status">読み込んでいます。</p>}><Await resolve={receipts} errorElement={<p role="status">受領状況を確認できません。既存の入出庫履歴で確認してください。</p>}>{items => items.length ? items.map(item => <p key={item.id}><SecondaryLink small to={`/app/history/${encodeURIComponent(item.id)}`}>入出庫履歴</SecondaryLink> {item.receivedQuantity === null ? "確認できません" : `受領 ${item.receivedQuantity} / 出庫 ${item.totalQuantity}`}・{{ TRANSFERRED: "入庫済み", IN_PROGRESS: "処理中", READY_TO_SHIP: "配送準備完了", DRAFT: "下書き", CANCELED: "取消済み" }[item.status] || "要確認"}</p>) : <p>発送の記録はまだありません。</p>}</Await></Suspense></AdminBlock>
    <AdminBlock wide title="対応履歴">{events.map(event => <p key={event.id}>{new Date(event.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}・{event.action}・{event.actor}</p>)}</AdminBlock>
  </div></s-page>;
}
