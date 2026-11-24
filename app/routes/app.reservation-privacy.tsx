import { ReservationNav } from "../components/ReservationNav";
import { Suspense } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Await, Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { AdminBlock, BackAction, ConfirmAction, StatusBanner, SuccessToast } from "../components/admin-ui";

// Mandatory privacy controls remain accessible without Pro or the reservation feature flag.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const requests = db.stockReservationPrivacyRequest.findMany({ where: { shop: session.shop }, select: { id: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  const ended = db.stockReservation.findMany({ where: { shop: session.shop, status: { in: ["sold", "cancelled", "failed"] }, anonymizedAt: null },
    select: { id: true, version: true, locationName: true }, orderBy: { createdAt: "asc" }, take: 25 });
  return data({ content: Promise.all([requests, ended]) }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const result = await db.stockReservation.updateMany({ where: { shop: session.shop, id: String(form.get("id")), version: Number(form.get("version")),
      status: { in: ["sold", "cancelled", "failed"] }, anonymizedAt: null }, data: { customerId: null, guestName: null, contactPhone: null, requestHash: null, anonymizedAt: new Date(), version: { increment: 1 } } });
    if (!result.count) return data({ ok: false, error: "この取置は更新されています。画面を更新してもう一度お試しください" }, { status: 409 });
    return data({ ok: true, error: "", saved: Date.now() });
  } catch { return data({ ok: false, error: "連絡先を削除できませんでした。もう一度お試しください" }, { status: 500 }); }
}
export default function ReservationPrivacy() {
  const { content } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return <s-page heading="取置"><BackAction to="/app/reservations" label="取置へ戻る" /><div className="Admin-body"><ReservationNav selected="customers" />
    <SuccessToast message={result?.ok ? "連絡先を削除しました" : null} trigger={result} />
    <Suspense fallback={<p role="status">読み込んでいます。</p>}><Await resolve={content} errorElement={<StatusBanner tone="critical" heading="顧客データを取得できませんでした">画面を更新してもう一度お試しください。</StatusBanner>}>{([requests, ended]) => <>
      {result?.error ? <StatusBanner tone="critical" heading="連絡先を削除できませんでした">{result.error}</StatusBanner> : null}
      <AdminBlock wide title="顧客データの開示依頼" description="ダウンロードしたデータは、本人確認のうえストアの手順で提供してください。">
        {!requests.length ? <p className="Admin-note">開示依頼はありません。</p> : requests.map(entry => <Form reloadDocument method="post" action="/app/reservations/privacy" key={entry.id}><input type="hidden" name="id" value={entry.id} /><button type="submit" className="Admin-secondary">{new Date(entry.createdAt).toLocaleDateString("ja-JP")} の依頼を書き出す</button></Form>)}
      </AdminBlock>
      <AdminBlock wide title="終了した取置の連絡先" description="氏名・電話番号・顧客との紐付けを削除できます。古い順に25件ずつ表示します。">
        {!ended.length ? <p className="Admin-note">削除できる連絡先はありません。</p> : ended.map(row => <div key={row.id} className="Admin-control"><p>{row.id}・{row.locationName}</p><ConfirmAction label="連絡先を削除" heading="連絡先を削除しますか" message="この取置の氏名・電話番号・顧客との紐付けを削除します。在庫と終了履歴は残ります。" fields={{ id: row.id, version: String(row.version) }} disabled={busy} /></div>)}
      </AdminBlock>
    </>}</Await></Suspense>
  </div></s-page>;
}
