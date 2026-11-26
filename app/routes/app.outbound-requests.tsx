import { Form, useLoaderData, useNavigation } from "react-router";
import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { requestLocations, type RequestRow } from "../utils/outbound-requests.server";
import { AdminBlock, EmptyState, GuardedLink, PickList, SecondaryLink, StateBadge } from "../components/admin-ui";
import { OutboundRequestNav } from "../components/outbound-request-ui";
import { OUTBOUND_REQUEST_LABELS, outboundRequestTone } from "../../extensions/common/outboundRequests.js";
import { REQUEST_LIST_PATH, REQUEST_PAGE_SIZE, requestFilters, requestListUrl, requestChildUrl, requestDate, type RequestFilters } from "../utils/outbound-request-view";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await outboundAdmin(request);
  const filters = requestFilters(new URL(request.url).searchParams);
  const where = {
    shop: session.shop,
    ...(filters.origins.length ? { originId: { in: filters.origins } } : {}),
    ...(filters.destinations.length ? { destinationId: { in: filters.destinations } } : {}),
    ...(filters.statuses.length ? { status: { in: filters.statuses } } : {}),
    ...(filters.query ? { OR: [{ number: { contains: filters.query, mode: "insensitive" as const } }, { note: { contains: filters.query, mode: "insensitive" as const } }] } : {}),
    ...(filters.from || filters.to ? { dueDate: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } } : {}),
  };
  const [count, locations] = await Promise.all([db.outboundRequest.count({ where }), requestLocations(admin)]);
  const page = Math.min(filters.page, Math.max(0, Math.ceil(count / REQUEST_PAGE_SIZE) - 1));
  const orderBy = filters.sort === "due"
    ? [{ dueDate: { sort: "asc" as const, nulls: "last" as const } }, { createdAt: "asc" as const }, { id: "asc" as const }]
    : [{ createdAt: filters.sort }, { id: filters.sort }];
  const rows = await db.outboundRequest.findMany({ where, orderBy, skip: page * REQUEST_PAGE_SIZE, take: REQUEST_PAGE_SIZE });
  return { rows: rows as unknown as RequestRow[], count, locations, filters: { ...filters, page } };
}

function ListFilters({ filters, locations, busy }: { filters: RequestFilters; locations: { id: string; name: string }[]; busy: boolean }) {
  const [origins, setOrigins] = useState(filters.origins), [destinations, setDestinations] = useState(filters.destinations), [statuses, setStatuses] = useState(filters.statuses);
  return <Form method="get">
    <AdminBlock wide title="フィルター" description="出庫元・移動先・状態などで依頼を絞り込みます。">
      <div className="Outreq-fields">
        <label>依頼番号・備考<input className="Admin-input" type="search" name="query" defaultValue={filters.query} /></label>
        <div><p>出庫元ロケーション</p><PickList label="出庫元" items={locations} value={origins} onChange={setOrigins} allLabel="全て" name="origin" /></div>
        <div><p>移動先ロケーション</p><PickList label="移動先" items={locations} value={destinations} onChange={setDestinations} allLabel="全て" name="destination" /></div>
        <div><p>ステータス</p><PickList label="ステータス" items={Object.entries(OUTBOUND_REQUEST_LABELS).map(([id, name]) => ({ id, name }))} value={statuses} onChange={setStatuses} allLabel="全て" name="status" /></div>
        <label>希望出庫日（開始）<input type="date" className="Admin-input" name="from" defaultValue={filters.from} /></label>
        <label>希望出庫日（終了）<input type="date" className="Admin-input" name="to" defaultValue={filters.to} min={filters.from || undefined} /></label>
      </div>
    </AdminBlock>
    <AdminBlock wide title="ソート" description="依頼の表示順を選びます。">
      <fieldset className="Outreq-sort"><legend>表示順</legend>
        {[["desc", "作成日 降順（新しい順）"], ["asc", "作成日 昇順（古い順）"], ["due", "希望出庫日 昇順（近い順）"]].map(([value, label]) => <label key={value}><input type="radio" name="sort" value={value} defaultChecked={filters.sort === value} />{label}</label>)}
      </fieldset>
      <div className="Outreq-actions"><button type="submit" className="Admin-secondary" disabled={busy}>{busy ? "読み込み中…" : "絞り込む"}</button><SecondaryLink to={REQUEST_LIST_PATH}>条件をクリア</SecondaryLink></div>
    </AdminBlock>
  </Form>;
}

export default function OutboundRequests() {
  const { rows, count, locations, filters } = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle", listUrl = requestListUrl(filters);
  const createUrl = requestChildUrl(REQUEST_LIST_PATH + "/new", listUrl);
  const pages = Math.max(1, Math.ceil(count / REQUEST_PAGE_SIZE));
  const filtered = Boolean(filters.origins.length || filters.destinations.length || filters.statuses.length || filters.query || filters.from || filters.to);
  return <s-page heading="出庫依頼"><div className="Admin-body">
    <OutboundRequestNav selected="list" returnTo={listUrl} />
    <div className="Outreq-split">
      <aside><h2 className="Outreq-heading">出庫依頼</h2><p className="Admin-note Outreq-intro">条件で絞り込みを行い、依頼を表示します。</p><ListFilters key={listUrl} filters={filters} locations={locations} busy={busy} /></aside>
      <main aria-busy={busy}>
        <AdminBlock wide title="依頼一覧" action={<SecondaryLink to={createUrl} icon="plus">依頼を追加</SecondaryLink>}>
          <p className="Admin-note">表示: {rows.length}件 / {count}件</p>
          {rows.length ? rows.map(row => <GuardedLink key={row.id} to={requestChildUrl(REQUEST_LIST_PATH + "/" + row.id, listUrl)} className="Outreq-row" aria-label={row.number + "の詳細"}>
            <div className="Outreq-row-top"><strong>{row.number}</strong><span className="Admin-note Outreq-row-date">希望日: {requestDate(row.dueDate)}</span></div>
            <p className="Admin-note">出庫元: {row.originName}</p><p className="Admin-note">移動先: {row.destinationName}</p>
            <div className="Outreq-row-bottom"><StateBadge tone={outboundRequestTone(row.status)} label={OUTBOUND_REQUEST_LABELS[row.status as keyof typeof OUTBOUND_REQUEST_LABELS] || "要確認"} /><span className="Admin-note Outreq-count">{row.lines.length}種類・合計{row.lines.reduce((sum, line) => sum + line.quantity, 0).toLocaleString("ja-JP")}点 ›</span></div>
          </GuardedLink>) : filtered ? <p className="Admin-note">条件に一致する依頼はありません。条件を変えてください。</p> : <EmptyState heading="出庫依頼はまだありません。">「依頼を追加」から作成してください。</EmptyState>}
          <nav className="Outreq-pager" aria-label="依頼一覧のページ送り">
            {filters.page ? <SecondaryLink to={requestListUrl(filters, filters.page - 1)}>前へ</SecondaryLink> : <span />}
            <span className="Admin-note">{filters.page + 1} / {pages}ページ</span>
            {filters.page + 1 < pages ? <SecondaryLink to={requestListUrl(filters, filters.page + 1)}>次へ</SecondaryLink> : <span />}
          </nav>
        </AdminBlock>
      </main>
    </div>
  </div></s-page>;
}
