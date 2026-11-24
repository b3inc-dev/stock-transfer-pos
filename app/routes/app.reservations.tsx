import { Suspense, useEffect, useState } from "react";
import { Await, Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useAppBridge } from "@shopify/app-bridge-react";
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
  const bridge = useAppBridge();
  const [missingScopes, setMissingScopes] = useState<string[]>([]);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState("");
  useEffect(() => { bridge.scopes.query().then(detail => setMissingScopes(["read_orders", "read_customers"].filter(scope => !detail.granted.includes(scope)))).catch(() => setScopeError("取置に必要な権限を確認できません。画面を更新してください")); }, [bridge]);
  const requestScopes = async () => {
    setScopeBusy(true); setScopeError("");
    try {
      const response = await bridge.scopes.request(missingScopes);
      setMissingScopes(["read_orders", "read_customers"].filter(scope => !response.detail.granted.includes(scope)));
      if (response.result !== "granted-all") setScopeError("権限が許可されませんでした。取置を利用するには顧客・注文の読み取りが必要です");
    } catch { setScopeError("権限を更新できませんでした。アプリの承認状況を確認してください"); }
    finally { setScopeBusy(false); }
  };
  return <s-page heading="取置"><div className="Admin-body">
    <SuccessToast message={result?.ok ? "連絡先を削除しました" : null} trigger={result} />
    {result?.error || scopeError ? <StatusBanner tone="critical" heading="操作を確認してください">{result?.error || scopeError}</StatusBanner> : null}
    {missingScopes.length ? <AdminBlock wide title="取置の利用権限" description="顧客と決済済み注文を照合するため、読み取り権限が必要です。" action={<button type="button" className="Admin-secondary" disabled={scopeBusy} onClick={requestScopes}>{scopeBusy ? "確認中…" : "権限を許可"}</button>}><p className="Admin-note">ストアの管理者が許可してください。</p></AdminBlock> : null}
    <AdminBlock wide title="顧客データ" action={<SecondaryLink to="/app/reservation-privacy">開示・削除へ</SecondaryLink>}><p className="Admin-note">プランに関係なく顧客データの依頼に対応できます。</p></AdminBlock>
    <AdminBlock wide title="店舗の取置" description="登録と会計はPOSの「取置」から行います。終了した取置の連絡先を削除できます。" action={<SecondaryLink to="/app/reservations/settings">期限を設定</SecondaryLink>}>
      <Form method="get"><s-checkbox label="終了した取置を表示" checked={ended} onChange={e => e.currentTarget.closest("form")?.requestSubmit()} name="ended" value="1" /></Form>
      <Suspense fallback={<p role="status">読み込んでいます。</p>}><Await resolve={rows} errorElement={<StatusBanner tone="critical" heading="取置を取得できませんでした">画面を更新してもう一度お試しください。</StatusBanner>}>{items => <>
        {!items.length ? <p className="Admin-note">取置はありません。</p> : <div className="Admin-link-list">{items.slice(0, 25).map(row => <div key={row.id} className="Admin-link-row">
          <GuardedLink to={`/app/reservations/${encodeURIComponent(row.id)}?ended=${ended ? 1 : 0}&page=${page}`} className="Admin-link-body" aria-label={`${row.id}の詳細`}>
            <div className="Admin-link-title">{row.id} ›</div><div className="Admin-link-text">{row.locationName}・期限 {row.dueDate}</div>
            <StateBadge label={RESERVATION_LABELS[row.status as keyof typeof RESERVATION_LABELS] || row.status} tone={row.status === "held" || row.status === "sold" ? "success" : row.status === "cancelled" ? "neutral" : "warning"} />
          </GuardedLink>
          {row.anonymizedAt ? <span className="Admin-note">連絡先削除済み</span> : row.endedAt || row.status === "failed" ? <ConfirmAction label="連絡先を削除" heading="連絡先を削除しますか" message="この取置の氏名・電話番号・顧客との紐付けを削除します。在庫と終了履歴は残ります。" fields={{ command: "anonymize", id: row.id, version: String(row.version) }} disabled={busy} /> : null}
        </div>)}</div>}
        <div className="Admin-pager">{page > 0 ? <SecondaryLink to={`?ended=${ended ? 1 : 0}&page=${page - 1}`}>前へ</SecondaryLink> : null}{items.length > 25 ? <SecondaryLink to={`?ended=${ended ? 1 : 0}&page=${page + 1}`}>次へ</SecondaryLink> : null}</div>
      </>}</Await></Suspense>
    </AdminBlock>
  </div></s-page>;
}
