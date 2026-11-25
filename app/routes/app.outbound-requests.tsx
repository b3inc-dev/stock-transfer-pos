import { Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { requestLocations, type RequestRow } from "../utils/outbound-requests.server";
import { AdminBlock, PrimaryLink, SecondaryLink, StateBadge } from "../components/admin-ui";
import { OUTBOUND_REQUEST_LABELS, outboundRequestTone } from "../../extensions/common/outboundRequests.js";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await outboundAdmin(request);
  const url = new URL(request.url), status = url.searchParams.get("status") || "", originId = url.searchParams.get("origin") || "", query = (url.searchParams.get("query") || "").slice(0, 100), page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const where = { shop: session.shop, ...(Object.hasOwn(OUTBOUND_REQUEST_LABELS, status) ? { status } : {}), ...(originId ? { originId } : {}), ...(query ? { OR: [{ number: { contains: query, mode: "insensitive" as const } }, { note: { contains: query, mode: "insensitive" as const } }] } : {}) };
  const [rows, count, locations] = await Promise.all([db.outboundRequest.findMany({ where, orderBy: { createdAt: "desc" }, skip: page * 25, take: 25 }), db.outboundRequest.count({ where }), requestLocations(admin)]);
  return { rows: rows as unknown as RequestRow[], count, locations, page, status, originId, query };
}
export default function OutboundRequests() {
  const { rows, count, locations, page, status, originId, query } = useLoaderData<typeof loader>();
  const pageLink = (next: number) => `?${new URLSearchParams({ page: String(next), status, origin: originId, query })}`;
  return <s-page heading="出庫依頼"><div className="Admin-body">
    <AdminBlock wide title="出庫依頼" description="依頼を登録し、出庫店舗で印刷・検品して出庫します。受領は既存の入庫で行います。" action={<PrimaryLink to="/app/outbound-requests/new" icon="plus">依頼を追加</PrimaryLink>}>
      <SecondaryLink to="/app/outbound-requests/settings">差異の設定</SecondaryLink>
      <Form method="get" className="Admin-filters">
        <label>出庫元<select name="origin" defaultValue={originId}><option value="">全て</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label>状態<select name="status" defaultValue={status}><option value="">全て</option>{Object.entries(OUTBOUND_REQUEST_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>依頼番号・備考<input name="query" defaultValue={query} /></label><button type="submit" className="Admin-secondary">絞り込む</button>
      </Form>
      <p className="Admin-note">{count}件</p>
      <div className="History-scroll"><table className="History-table"><thead><tr><th>依頼</th><th>出庫元 → 移動先</th><th>希望日</th><th>状態</th><th>操作</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td data-label="依頼">{row.number}</td><td data-label="店舗">{row.originName} → {row.destinationName}</td><td data-label="希望日">{row.dueDate || "指定なし"}</td><td data-label="状態"><StateBadge tone={outboundRequestTone(row.status)} label={OUTBOUND_REQUEST_LABELS[row.status as keyof typeof OUTBOUND_REQUEST_LABELS] || "要確認"} /></td><td data-label="操作"><SecondaryLink small to={`/app/outbound-requests/${row.id}`}>詳細</SecondaryLink></td></tr>)}</tbody></table></div>
      {!rows.length ? <p>条件に一致する依頼はありません。</p> : null}
      <div className="Admin-pager">{page ? <SecondaryLink to={pageLink(page - 1)}>前へ</SecondaryLink> : null}{(page + 1) * 25 < count ? <SecondaryLink to={pageLink(page + 1)}>次へ</SecondaryLink> : null}</div>
    </AdminBlock>
  </div></s-page>;
}
