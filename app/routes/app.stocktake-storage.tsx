// app/routes/app.stocktake-storage.tsx
// 棚卸データの保存先（legacy / dual / db）の移行操作。ナビには出さない運用者向けページ。

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, data } from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import {
  backfillFromLegacy,
  getStorageStatus,
  runMirrorSync,
  switchMode,
  verifyAgainstLegacy,
} from "../utils/stocktake-count-store.server";
import { parseStorageMode } from "../utils/stocktake-count-store-logic";

async function getOwnerId(admin: { graphql: (q: string) => Promise<Response> }): Promise<string> {
  const resp = await admin.graphql(`#graphql query GetAppInstallation { currentAppInstallation { id } }`);
  const json = (await resp.json().catch(() => ({}))) as { data?: { currentAppInstallation?: { id?: string } } };
  return json?.data?.currentAppInstallation?.id ?? "";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const status = await getStorageStatus(session.shop);
  return data({ shop: session.shop, status }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function action({ request }: ActionFunctionArgs) {
  const auth = await authenticate.admin(request);
  const admin = withGraphQLRetry(auth.admin);
  const shop = auth.session.shop;
  const form = await request.formData();
  const op = String(form.get("op") ?? "");
  try {
    if (op === "backfill") return { op, ...(await backfillFromLegacy(shop, admin)) };
    if (op === "verify") return { op, ok: true, ...(await verifyAgainstLegacy(shop, admin)) };
    const ownerId = await getOwnerId(admin);
    if (!ownerId) return { op, ok: false, error: "currentAppInstallation.id が取得できませんでした" };
    if (op === "mirror") return { op, ...(await runMirrorSync(shop, admin, ownerId)) };
    if (op === "mode") {
      const target = parseStorageMode(form.get("mode"));
      if (!target) return { op, ok: false, error: "mode は legacy / dual / db のいずれか" };
      return { op, ...(await switchMode(shop, admin, ownerId, target, { force: form.get("force") === "1" })) };
    }
    return { op, ok: false, error: `unknown op: ${op}` };
  } catch (e) {
    return { op, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function StocktakeStoragePage() {
  const { shop, status } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const submit = (fields: Record<string, string>) => {
    if (fields.op === "mode" && !window.confirm(`保存先を「${fields.mode}」に切り替えます。よろしいですか？`)) return;
    fetcher.submit(fields, { method: "post" });
  };

  return (
    <s-page heading="棚卸データの保存先">
      <s-section heading="現在の状態">
        <s-paragraph>ショップ: {shop}</s-paragraph>
        <s-paragraph>
          実効モード: <strong>{status.effectiveMode}</strong>（環境変数: {status.envMode ?? "未設定 = legacy"} / ショップ設定:{" "}
          {status.state?.modeOverride ?? "なし"}）
        </s-paragraph>
        <s-paragraph>
          DB の棚卸: {status.documents} 件（新形式 {status.documentsV2} 件）/ 再試行バックアップ: {status.pendingBackups} 件
        </s-paragraph>
        <s-paragraph>
          移し替え: {status.state?.backfilledAt ? String(status.state.backfilledAt) : "未実施"} / 書き写し待ち:{" "}
          {status.state?.mirrorDirty ? "あり" : "なし"} / 最終書き写し: {status.state?.mirroredAt ? String(status.state.mirroredAt) : "—"}
        </s-paragraph>
        {status.state?.lastError ? <s-paragraph>直近のエラー: {status.state.lastError}</s-paragraph> : null}
      </s-section>
      <s-section heading="操作（上から順に）">
        <s-paragraph>1. 並行記録（dual）に切り替え → 2. 移し替え → 3. 照合で差分 0 を確認 → 4. DB へ切替（db）。戻すときは「並行記録に戻す」。</s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button disabled={busy} onClick={() => submit({ op: "mode", mode: "dual" })}>並行記録（dual）にする</s-button>
          <s-button disabled={busy} onClick={() => submit({ op: "backfill" })}>移し替え</s-button>
          <s-button disabled={busy} onClick={() => submit({ op: "verify" })}>照合</s-button>
          <s-button disabled={busy} variant="primary" onClick={() => submit({ op: "mode", mode: "db" })}>DB へ切替（db）</s-button>
          <s-button disabled={busy} onClick={() => submit({ op: "mirror" })}>今すぐ書き写し</s-button>
          <s-button disabled={busy} onClick={() => submit({ op: "mode", mode: "dual" })}>並行記録に戻す</s-button>
          <s-button disabled={busy} tone="critical" onClick={() => submit({ op: "mode", mode: "legacy" })}>現行（legacy）に戻す</s-button>
        </s-stack>
      </s-section>
      {fetcher.data ? (
        <s-section heading="結果">
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(fetcher.data, null, 2)}</pre>
        </s-section>
      ) : null}
    </s-page>
  );
}
