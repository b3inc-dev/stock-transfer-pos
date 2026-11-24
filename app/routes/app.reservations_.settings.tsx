import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { reservationsEnabled } from "../utils/reservations.server";
import { AdminBlock, BackAction, SaveBar, StatusBanner, UnitInput } from "../components/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const settings = await db.stockReservationSettings.findUnique({ where: { shop: session.shop } });
  return data({ days: settings?.days ?? 7 }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function action({ request }: ActionFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { admin, session } = await authenticate.admin(request);
  const blocked = await adminPlanRedirect(request, admin, session.shop, "reservation");
  if (blocked) return blocked;
  const form = await request.formData();
  const days = Number(form.get("days"));
  if (!Number.isInteger(days) || days < 1 || days > 365) return data({ ok: false, error: "標準取置日数は1〜365日の整数で入力してください", saved: 0 }, { status: 400 });
  try {
    await db.stockReservationSettings.upsert({ where: { shop: session.shop }, create: { shop: session.shop, days }, update: { days } });
    return data({ ok: true, error: "", saved: Date.now() });
  } catch { return data({ ok: false, error: "設定を保存できませんでした。もう一度お試しください", saved: 0 }, { status: 500 }); }
}
export default function ReservationSettings() {
  const { days } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return <s-page heading="取置の期限"><BackAction to="/app/reservations" label="取置へ戻る" /><div className="Admin-body">
    {result?.error ? <StatusBanner tone="critical" heading="設定を保存できませんでした">{result.error}</StatusBanner> : null}
    <Form method="post"><SaveBar status={result?.ok ? result.saved : undefined} failed={result?.ok === false} />
      <AdminBlock title="受取期限" description="登録日の何日後まで取り置くかを全店舗共通で設定します。変更は新しい取置に適用されます。">
        <UnitInput label="標準取置日数" unit="日" name="days" type="number" min={1} max={365} step={1} defaultValue={days} required disabled={busy} />
      </AdminBlock>
    </Form>
  </div></s-page>;
}
