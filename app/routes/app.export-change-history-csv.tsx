// app/routes/app.export-change-history-csv.tsx
// 在庫変動履歴CSVエクスポート専用リソースルート（コンポーネントなし）。
// 同一ページへの POST だと Remix が HTML を返してしまうため、このルートへ POST すると CSV がそのまま返る。
import type { ActionFunctionArgs } from "react-router";
import { exportChangeHistoryCsv } from "../export-change-history-csv.server";

export async function action({ request }: ActionFunctionArgs) {
  return exportChangeHistoryCsv(request);
}
