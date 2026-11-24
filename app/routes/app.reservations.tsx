import { reservationDisplayNumber , RESERVATION_LABELS, reservationStatusTone } from "../../extensions/common/reservations.js";
import { ReservationNav } from "../components/ReservationNav";
import { Suspense } from "react";
import { Await, Form, data, useActionData, useLoaderData, useNavigation, useLocation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { reservationQuery, reservationsEnabled } from "../utils/reservations.server";
import { GuardedLink, SecondaryLink, StateBadge, StatusBanner, SuccessToast } from "../components/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedLocations = [...new Set(url.searchParams.getAll("locations"))].filter(id => /^gid:\/\/shopify\/Location\/\d+$/.test(id));
  const selectedStatuses = [...new Set(url.searchParams.getAll("statuses"))].filter(status => Object.hasOwn(RESERVATION_LABELS, status));
  // Old history links remain usable after moving to explicit status filters.
  const ended = url.searchParams.get("ended") === "1";
  const sort = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
  const where = { shop: session.shop, ...(selectedLocations.length ? { locationId: { in: selectedLocations } } : {}),
    ...(selectedStatuses.length ? { status: { in: selectedStatuses } } : ended ? { status: { in: ["sold", "cancelled", "failed"] } } : {}) };
  let locationError = "";
  const locationRequest = (async () => {
    const result: { locationId: string; locationName: string }[] = [];
    let after: string | null = null;
    do {
      const info = await reservationQuery(withGraphQLRetry(admin), `#graphql
        query ReservationHistoryLocations($after: String) { locations(first: 250, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }`, { after });
      result.push(...info.locations.nodes.map((location: { id: string; name: string }) => ({ locationId: location.id, locationName: location.name })));
      const next = info.locations.pageInfo.hasNextPage ? info.locations.pageInfo.endCursor : null;
      if (info.locations.pageInfo.hasNextPage && (!next || next === after)) throw new Error("location pagination failed");
      after = next;
    } while (after);
    return result;
  })().catch(() => { locationError = "ロケーションを取得できません。画面を再読込してもう一度お試しください。"; return []; });
  const [total, allTotal, locations] = await Promise.all([
    db.stockReservation.count({ where }), db.stockReservation.count({ where: { shop: session.shop } }), locationRequest,
  ]);
  const requestedPage = Number(url.searchParams.get("page"));
  const page = Math.min(Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0, Math.max(0, Math.ceil(total / 25) - 1));
  const rows = db.stockReservation.findMany({ where, orderBy: [{ createdAt: sort }, { id: sort }], take: 25, skip: page * 25,
    select: { id: true, number: true, locationName: true, status: true, dueDate: true, createdAt: true, lines: true } });
  return data({ rows, page, ended, selectedLocations, selectedStatuses, sort, total, allTotal, locations, locationError }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function action({ request }: ActionFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { admin, session } = await authenticate.admin(request);
  const blocked = await adminPlanRedirect(request, admin, session.shop, "reservation");
  if (blocked) return blocked;
  const form = await request.formData();
  if (form.get("command") !== "anonymize") return data({ error: "操作を確認してください", ok: false }, { status: 400 });
  try {
    const result = await db.stockReservation.updateMany({ where: { id: String(form.get("id")), shop: session.shop,
      version: Number(form.get("version")), status: { in: ["sold", "cancelled", "failed"] }, anonymizedAt: null },
      data: { customerId: null, guestName: null, contactPhone: null, requestHash: null, anonymizedAt: new Date(), version: { increment: 1 } } });
    if (!result.count) return data({ ok: false, error: "終了済みの取置を更新してからもう一度お試しください" }, { status: 409 });
    return data({ ok: true, error: "", saved: Date.now() });
  } catch { return data({ ok: false, error: "連絡先を削除できませんでした。もう一度お試しください" }, { status: 500 }); }
}
export default function Reservations() {
  const { rows, page, ended, selectedLocations, selectedStatuses, sort, total, allTotal, locations, locationError } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { search } = useLocation();
  const pageLink = (next: number) => { const params = new URLSearchParams(search); params.set("page", String(next)); return `?${params}`; };
  return <s-page heading="取置"><div className="Admin-body"><ReservationNav selected="history" />
    <SuccessToast message={result?.ok ? "連絡先を削除しました" : null} trigger={result} />
    {result?.error || locationError ? <StatusBanner tone="critical" heading={result?.error ? "操作を確認してください" : "ロケーションを取得できませんでした"}>{result?.error || locationError}</StatusBanner> : null}
    <div className="Reservation-history"><aside>
      <p><strong>取置履歴</strong></p><p className="Admin-note">条件で絞り込みを行い、取置履歴を表示します。</p>
      <Form key={search} method="get" onChange={event => event.currentTarget.requestSubmit()}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="Admin-card Reservation-history-card"><h2 className="Admin-title">フィルター</h2><p className="Admin-note">ロケーション・ステータスを選ぶと一覧が絞り込まれます。</p>
            <s-divider /><p><strong>ロケーション</strong></p><div className="Reservation-options">
              <label className="Reservation-option"><input type="checkbox" checked={!selectedLocations.length} onChange={event => { if (event.currentTarget.checked) { const form = event.currentTarget.form; form?.querySelectorAll<HTMLInputElement>('input[name="locations"]').forEach(input => { input.checked = false; }); } }} /><span>全て</span></label>
              {locations.map(location => <label className="Reservation-option" key={location.locationId}><input type="checkbox" name="locations" value={location.locationId} defaultChecked={selectedLocations.includes(location.locationId)} /><span>{location.locationName}</span></label>)}
            </div>
            <p><strong>ステータス</strong></p><div className="Reservation-options Reservation-status-options">
              <label className="Reservation-option"><input type="checkbox" checked={!selectedStatuses.length && !ended} onChange={event => { if (event.currentTarget.checked) event.currentTarget.form?.querySelectorAll<HTMLInputElement>('input[name="statuses"]').forEach(input => { input.checked = false; }); }} /><span>全て</span></label>
              {Object.entries(RESERVATION_LABELS).map(([key, label]) => <label className="Reservation-option" key={key}><input type="checkbox" name="statuses" value={key} defaultChecked={selectedStatuses.includes(key) || (ended && ["sold", "cancelled", "failed"].includes(key))} /><span>{label}{["reserving", "cancelling", "completing"].includes(key) ? key === "reserving" ? "（登録）" : key === "cancelling" ? "（解除）" : "（販売）" : ""}</span></label>)}
            </div>
          </div>
          <div className="Admin-card Reservation-history-card"><h2 className="Admin-title">ソート</h2><p className="Admin-note">受付日時の表示順を選びます。</p><s-divider /><div className="Reservation-sort-options">
            <label className="Reservation-option"><input type="radio" name="sort" value="desc" defaultChecked={sort === "desc"} /><span>受付日時 降順（新しい順）</span></label>
            <label className="Reservation-option"><input type="radio" name="sort" value="asc" defaultChecked={sort === "asc"} /><span>受付日時 昇順（古い順）</span></label>
          </div></div>
        </fieldset>
      </Form>
    </aside><section aria-label="取置履歴一覧"><div className="Admin-card Reservation-history-card"><p className="Admin-note">表示: {total}件 / {allTotal}件</p>
      <Suspense fallback={<p role="status">読み込んでいます。</p>}><Await resolve={rows} errorElement={<StatusBanner tone="critical" heading="取置を取得できませんでした">画面を更新してもう一度お試しください。</StatusBanner>}>{items => <>
        {!items.length ? <><p className="Admin-note">条件に一致する取置はありません。</p><SecondaryLink to="/app/reservations">すべて表示する</SecondaryLink></> : items.map(row => {
          const lines = Array.isArray(row.lines) ? row.lines as { quantity?: number }[] : [];
          const quantity = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
          return <GuardedLink key={row.id} to={`/app/reservations/${encodeURIComponent(row.id)}${pageLink(page)}`} className="Reservation-row" aria-label={`${reservationDisplayNumber(row)}の詳細`}>
            <strong>{reservationDisplayNumber(row)}</strong><span className="Reservation-row-end Admin-note">{new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.createdAt))}</span>
            <p className="Admin-note">ロケーション: {row.locationName}</p><span />
            <p className="Admin-note">受取期限: {row.dueDate}</p><span />
            <span><StateBadge label={RESERVATION_LABELS[row.status as keyof typeof RESERVATION_LABELS] || "確認中"} tone={reservationStatusTone(row.status)} /></span><span className="Reservation-row-end Admin-note">{lines.length}件・合計{quantity}点</span>
          </GuardedLink>;
        })}
        <div className="Admin-pager">{page > 0 ? <SecondaryLink to={pageLink(page - 1)}>前へ</SecondaryLink> : null}{(page + 1) * 25 < total ? <SecondaryLink to={pageLink(page + 1)}>次へ</SecondaryLink> : null}</div>
      </>}</Await></Suspense>
    </div></section></div>
  </div></s-page>;
}
