import { ReservationNav } from "../components/ReservationNav";
import { Suspense } from "react";
import { Await, Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { reservationsEnabled } from "../utils/reservations.server";
import { RESERVATION_LABELS } from "../../extensions/common/reservations.js";
import { AdminBlock, ConfirmAction, GuardedLink, SecondaryLink, StateBadge, StatusBanner, SuccessToast } from "../components/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
  const ended = url.searchParams.get("ended") === "1";
  const where = { shop: session.shop, ...(ended ? { status: { in: ["sold", "cancelled", "failed"] } } : { status: { notIn: ["sold", "cancelled", "failed"] } }) };
  const rows = db.stockReservation.findMany({ where, orderBy: { createdAt: "desc" }, take: 26, skip: page * 25,
    select: { id: true, locationName: true, status: true, dueDate: true, createdAt: true, endedAt: true, anonymizedAt: true, version: true } });
  return data({ rows, page, ended }, { headers: { "Cache-Control": "private, no-store" } });
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
  const { rows, page, ended } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return <s-page heading="取置"><div className="Admin-body"><ReservationNav selected="history" />
    <SuccessToast message={result?.ok ? "連絡先を削除しました" : null} trigger={result} />
    {result?.error ? <StatusBanner tone="critical" heading="操作を確認してください">{result.error}</StatusBanner> : null}
    <AdminBlock wide title="取置履歴" description="登録と会計はPOSの「取置」から行います。終了した取置の連絡先を削除できます。">
      <Form method="get"><s-checkbox label="終了した取置を表示" checked={ended} onChange={e => e.currentTarget.closest("form")?.requestSubmit()} name="ended" value="1" /></Form>
      <Suspense fallback={<p role="status">読み込んでいます。</p>}><Await resolve={rows} errorElement={<StatusBanner tone="critical" heading="取置を取得できませんでした">画面を更新してもう一度お試しください。</StatusBanner>}>{items => <>
        {!items.length ? <p className="Admin-note">取置はありません。</p> : <div className="History-scroll"><table className="History-table"><thead><tr><th>取置番号</th><th>受付日時</th><th>ロケーション</th><th>受取期限</th><th>ステータス</th><th>連絡先</th></tr></thead><tbody>{items.slice(0, 25).map(row => <tr key={row.id}>
          <td data-label="取置番号" className="History-id"><GuardedLink to={`/app/reservations/${encodeURIComponent(row.id)}?ended=${ended ? 1 : 0}&page=${page}`} aria-label={`${row.id}の詳細`}>{row.id} ›</GuardedLink></td>
          <td data-label="受付日時" className="History-keep">{new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(row.createdAt))}</td>
          <td data-label="ロケーション">{row.locationName}</td><td data-label="受取期限" className="History-keep">{row.dueDate}</td>
          <td data-label="ステータス" className="History-keep"><StateBadge label={RESERVATION_LABELS[row.status as keyof typeof RESERVATION_LABELS] || row.status} tone={row.status === "held" || row.status === "sold" ? "success" : row.status === "cancelled" ? "neutral" : "warning"} /></td>
          <td data-label="連絡先">{row.anonymizedAt ? <span className="Admin-note">削除済み</span> : row.endedAt || row.status === "failed" ? <ConfirmAction label="連絡先を削除" heading="連絡先を削除しますか" message="この取置の氏名・電話番号・顧客との紐付けを削除します。在庫と終了履歴は残ります。" fields={{ command: "anonymize", id: row.id, version: String(row.version) }} disabled={busy} /> : "—"}</td>
        </tr>)}</tbody></table></div>}

        <div className="Admin-pager">{page > 0 ? <SecondaryLink to={`?ended=${ended ? 1 : 0}&page=${page - 1}`}>前へ</SecondaryLink> : null}{items.length > 25 ? <SecondaryLink to={`?ended=${ended ? 1 : 0}&page=${page + 1}`}>次へ</SecondaryLink> : null}</div>
      </>}</Await></Suspense>
    </AdminBlock>
  </div></s-page>;
}
