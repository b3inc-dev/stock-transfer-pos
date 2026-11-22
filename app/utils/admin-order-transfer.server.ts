/**
 * 管理画面の発注の承認から Shopify の移管（Transfer）を作る（app.order.tsx の createTransferForOrder から呼ぶ）。
 * docs/IDEMPOTENT_MIGRATION.md 4.6 の L（2 段目）。
 *
 * - `inventoryTransferCreateAsReadyToShip`（段 `transfer_ready`）と、それが例外になったときの代わりの
 *   `inventoryTransferCreate`（段 `transfer_draft`）に `@idempotent(key: $idempotencyKey)`。違う mutation なので段を分ける
 *   （同じキーで違う中身を送らない）
 * - キーは画面の opKey + 発注の ID + approve、回は「承認を取り消した回数」（rv1…）+ 画面の opRound
 * - 代わりの道の `inventoryTransferMarkAsReadyToShip` は 17 の一覧に無いので付けない（2 章）
 * - 前と同じく、作れなかったときも承認は続ける。ただし @idempotent の返事（処理中のまま・中身の違い）のときは
 *   作れたか分からないので `uncertain: true` を返す（呼び出し側は承認を止めて opKey を残す）
 */
import { retryWhileIdempotencyConcurrent } from "./graphql-with-retry";
import { classifyIdempotencyErrors } from "./idempotency-key.server";
import { adminIdempotencyKey, classifyAdminWrite, type AdminIdempotency } from "./admin-op-key.server";

export const ORDER_TRANSFER_READY_STAGE = "transfer_ready";
export const ORDER_TRANSFER_DRAFT_STAGE = "transfer_draft";

export const ORDER_TRANSFER_READY_MUTATION = `#graphql
  mutation CreateTransferReadyForOrder($input: InventoryTransferCreateAsReadyToShipInput!, $idempotencyKey: String!) {
    inventoryTransferCreateAsReadyToShip(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryTransfer { id status name }
      userErrors { field message code }
    }
  }
`;

export const ORDER_TRANSFER_DRAFT_MUTATION = `#graphql
  mutation CreateTransferDraft($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
    inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryTransfer { id status }
      userErrors { field message code }
    }
  }
`;

const MARK_READY_MUTATION = `#graphql
  mutation MarkAsReadyToShip($id: ID!) {
    inventoryTransferMarkAsReadyToShip(id: $id) {
      inventoryTransfer { id status }
      userErrors { field message }
    }
  }
`;

type AdminGraphql = { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

export type OrderTransferInput = {
  destinationLocationId: string;
  lineItems: Array<{ inventoryItemId: string; quantity: number }>;
  note?: string;
};

export type OrderTransferResult = {
  transferId: string | null;
  error: string | null;
  /** 作れたか分からない（@idempotent の返事）。呼び出し側は承認を止める */
  uncertain?: boolean;
};

type CreateJson = {
  data?: Record<string, { inventoryTransfer?: { id?: string } | null; userErrors?: Array<{ field?: unknown; message?: string; code?: string }> } | null>;
  errors?: Array<{ message?: string; extensions?: { code?: unknown } }>;
};

type UserErrorLike = { field?: unknown; message?: unknown };
const formatUserErrors = (errs: ReadonlyArray<UserErrorLike>) =>
  errs.map((e) => `${e.field ?? ""}: ${e.message ?? ""}`).join(" / ");

async function sendCreate(
  admin: AdminGraphql,
  mutation: string,
  field: string,
  input: OrderTransferInput,
  idempotencyKey: string,
  delays: number[] | undefined
): Promise<{ json: CreateJson; concurrentExhausted: boolean }> {
  const variables = { input, idempotencyKey };
  const sent = await retryWhileIdempotencyConcurrent<CreateJson>(
    async () => (await (await admin.graphql(mutation, { variables })).json()) as CreateJson,
    (j) => classifyIdempotencyErrors(j?.data?.[field]?.userErrors, j?.errors) === "concurrent",
    delays
  );
  return { json: sent.result, concurrentExhausted: sent.concurrentExhausted };
}

export async function createOrderTransferIdempotent(
  admin: AdminGraphql,
  input: OrderTransferInput,
  idem: AdminIdempotency
): Promise<OrderTransferResult> {
  // まず inventoryTransferCreateAsReadyToShip を試す
  try {
    const { json: data, concurrentExhausted } = await sendCreate(
      admin,
      ORDER_TRANSFER_READY_MUTATION,
      "inventoryTransferCreateAsReadyToShip",
      input,
      adminIdempotencyKey(idem, ORDER_TRANSFER_READY_STAGE),
      idem.concurrentRetryDelaysMs
    );
    const payload = data?.data?.inventoryTransferCreateAsReadyToShip;
    const c = classifyAdminWrite(payload?.userErrors, data.errors, concurrentExhausted);
    if (c.outcome === "uncertain" && c.idempotencyIssue) {
      return { transferId: null, error: `Transfer作成の結果が分からない（${c.idempotencyIssue}）: ${c.message}`, uncertain: true };
    }
    // GraphQL エラー（ネットワークエラーなど）
    if (data.errors && data.errors.length > 0) {
      const errorMessages = data.errors.map((e: { message?: string }) => e.message || String(e)).join(" / ");
      return { transferId: null, error: `GraphQLエラー: ${errorMessages}` };
    }
    if (c.outcome === "rejected") {
      return { transferId: null, error: `Transfer作成エラー: ${formatUserErrors(payload?.userErrors ?? [])}` };
    }
    const transferId = payload?.inventoryTransfer?.id ?? null;
    if (!transferId) {
      return { transferId: null, error: "Transfer ID が取得できませんでした" };
    }
    return { transferId, error: null };
  } catch {
    // inventoryTransferCreateAsReadyToShip が使えない場合（APIバージョンが古いなど）、
    // Draft を作成してから ReadyToShip にマークする方法を試す（前からの動き）
    try {
      const { json: draftData, concurrentExhausted } = await sendCreate(
        admin,
        ORDER_TRANSFER_DRAFT_MUTATION,
        "inventoryTransferCreate",
        input,
        adminIdempotencyKey(idem, ORDER_TRANSFER_DRAFT_STAGE),
        idem.concurrentRetryDelaysMs
      );
      const draftPayload = draftData?.data?.inventoryTransferCreate;
      const c = classifyAdminWrite(draftPayload?.userErrors, draftData.errors, concurrentExhausted);
      if (c.outcome === "uncertain" && c.idempotencyIssue) {
        return { transferId: null, error: `Draft作成の結果が分からない（${c.idempotencyIssue}）: ${c.message}`, uncertain: true };
      }
      if (draftData.errors && draftData.errors.length > 0) {
        const errorMessages = draftData.errors.map((e: { message?: string }) => e.message || String(e)).join(" / ");
        return { transferId: null, error: `Draft作成エラー: ${errorMessages}` };
      }
      if (c.outcome === "rejected") {
        return { transferId: null, error: `Draft作成エラー: ${formatUserErrors(draftPayload?.userErrors ?? [])}` };
      }
      const draftId = draftPayload?.inventoryTransfer?.id;
      if (!draftId) {
        return { transferId: null, error: "Draft Transfer ID が取得できませんでした" };
      }

      // 2. ReadyToShip にマーク
      const markResp = await admin.graphql(MARK_READY_MUTATION, { variables: { id: draftId } });
      const markData = (await markResp.json()) as CreateJson;
      if (markData.errors && markData.errors.length > 0) {
        const errorMessages = markData.errors.map((e: { message?: string }) => e.message || String(e)).join(" / ");
        return { transferId: null, error: `ReadyToShipマークエラー: ${errorMessages}` };
      }
      const markPayload = markData?.data?.inventoryTransferMarkAsReadyToShip;
      const markUserErrors = markPayload?.userErrors ?? [];
      if (markUserErrors.length) {
        return { transferId: null, error: `ReadyToShipマークエラー: ${formatUserErrors(markUserErrors)}` };
      }
      return { transferId: markPayload?.inventoryTransfer?.id ?? draftId, error: null };
    } catch (fallbackError) {
      const errorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      return { transferId: null, error: `フォールバック処理エラー: ${errorMessage}` };
    }
  }
}
