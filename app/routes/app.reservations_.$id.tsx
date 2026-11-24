import { ReservationNav } from "../components/ReservationNav";
import { Suspense } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Await, data, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { reservationsEnabled } from "../utils/reservations.server";
import { reservationAdminDetail, reservationDetailSelect, reservationEventSelect, reservationListState, reservationFilterQuery } from "../utils/reservation-admin-detail.server";
import { AdminBlock, BackAction, SecondaryLink, StateBadge, StatusBanner } from "../components/admin-ui";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const { session, sessionToken, admin } = await authenticate.admin(request);
  const blocked = await adminPlanRedirect(request, admin, session.shop, "reservation");
  if (blocked) return blocked;
  const id = String(params.id || "");
  const state = reservationListState(new URL(request.url));
  const row = await db.stockReservation.findFirst({ where: { shop: session.shop, id }, select: { ...reservationDetailSelect,
    events: { select: reservationEventSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 26, skip: state.historyPage * 25 } } });
  if (!row) throw new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const detail = reservationAdminDetail({ row, shop: session.shop, subject: sessionToken?.sub || "", admin: withGraphQLRetry(admin) });
  const filters = reservationFilterQuery(new URL(request.url));
  const backTo = `/app/reservations?ended=${state.ended ? 1 : 0}&page=${state.page}${filters}`;
  const historyBase = `/app/reservations/${encodeURIComponent(id)}?ended=${state.ended ? 1 : 0}&page=${state.page}${filters}&historyPage=`;
  return data({ detail, backTo, historyBase, historyPage: state.historyPage }, { headers: { "Cache-Control": "private, no-store" } });
}
export default function ReservationDetail() {
  const { detail, backTo, historyBase, historyPage } = useLoaderData<typeof loader>();
  return <s-page heading="取置の詳細"><BackAction to={backTo} label="取置へ戻る" /><div className="Admin-body"><ReservationNav selected="history" />
    <Suspense fallback={<p role="status">読み込んでいます。</p>}><Await resolve={detail} errorElement={<StatusBanner tone="critical" heading="取置を取得できませんでした">画面を更新してもう一度お試しください。</StatusBanner>}>{entry => <>
      {entry.notice ? <StatusBanner tone={entry.notice.tone} heading={entry.notice.heading}>{entry.notice.message}</StatusBanner> : null}
      <div className="Admin-home">
        <div className="Admin-home-side"><AdminBlock wide title="取置の状況">
          <StateBadge label={entry.statusLabel} tone={entry.statusTone} />
          <dl className="Admin-member-grid"><div><dt>取置番号</dt><dd>{entry.displayNumber}</dd></div><div><dt>受付方法</dt><dd>{entry.intakeLabel}</dd></div><div><dt>店舗</dt><dd>{entry.locationName}</dd></div><div><dt>受取期限</dt><dd>{entry.dueDate}</dd></div><div><dt>次回確認日</dt><dd>{entry.nextFollowDate}</dd></div><div><dt>点数</dt><dd>{entry.totalQuantity}点</dd></div></dl>
        </AdminBlock></div>
        <div className="Admin-home-main"><AdminBlock wide title="お客様">
          <dl className="Admin-member-grid"><div><dt>お名前</dt><dd>{entry.name}</dd></div><div><dt>連絡用電話番号</dt><dd>{entry.phone}</dd></div></dl>
          {!entry.contactVisible && !entry.anonymized ? <p className="Admin-note">連絡先の全文表示には、この店舗の連絡先を参照する権限が必要です。</p> : null}
        </AdminBlock></div>
      </div>
      <AdminBlock wide title="取置商品"><table className="History-table"><thead><tr><th>商品・種類</th><th className="History-num">数量</th></tr></thead><tbody>{entry.lines.map((line, index) => <tr key={index}><td data-label="商品・種類">{line.title}</td><td data-label="数量" className="History-num">{line.quantity}</td></tr>)}</tbody></table></AdminBlock>
      <AdminBlock wide title="受付・販売・キャンセル" action={entry.order ? <s-button href={entry.order.href} target="_top" variant="secondary">{entry.order.label}</s-button> : undefined}>
        <dl className="Admin-member-grid"><div><dt>受付日時</dt><dd>{entry.createdAt}</dd></div><div><dt>受付担当</dt><dd>{entry.createdBy}</dd></div><div><dt>会計へ渡した担当</dt><dd>{entry.checkoutBy}</dd></div><div><dt>終了日時</dt><dd>{entry.endedAt}</dd></div><div><dt>終了担当</dt><dd>{entry.endedBy}</dd></div></dl>
        <p className="Admin-note">日時は日本時間です。担当者名が保存されていないため、記録された担当番号で表示します。</p>
      </AdminBlock>
      <AdminBlock wide title="対応履歴" description="新しい記録から表示します。">
        {!entry.events.length ? <p className="Admin-note">対応の記録はありません。</p> : <table className="History-table"><thead><tr><th>日時</th><th>内容</th><th>次回確認日</th><th>担当者</th></tr></thead><tbody>{entry.events.map(event => <tr key={event.id}><td data-label="日時" className="History-keep">{event.at}</td><td data-label="内容">{event.label}</td><td data-label="次回確認日" className="History-keep">{event.followDate}</td><td data-label="担当者">{event.actor}</td></tr>)}</tbody></table>}
        <div className="Admin-pager">{historyPage > 0 ? <SecondaryLink to={`${historyBase}${historyPage - 1}`}>前へ</SecondaryLink> : null}{entry.hasNextHistory ? <SecondaryLink to={`${historyBase}${historyPage + 1}`}>次へ</SecondaryLink> : null}</div>
      </AdminBlock>
    </>}</Await></Suspense>
  </div></s-page>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return <s-page heading="取置の詳細"><BackAction to="/app/reservations" label="取置へ戻る" /><div className="Admin-body"><ReservationNav selected="history" /><StatusBanner tone="critical" heading={missing ? "取置が見つかりませんでした" : "取置を取得できませんでした"}>{missing ? "一覧へ戻り、取置を選び直してください。" : "通信状態を確認して、もう一度お試しください。"}</StatusBanner></div></s-page>;
}
