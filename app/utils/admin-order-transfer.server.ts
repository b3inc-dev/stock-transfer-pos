/**
 * 管理画面の発注の承認から Shopify の移管（Transfer）を作る（app.order.tsx の createTransferForOrder から呼ぶ）。
 * docs/IDEMPOTENT_MIGRATION.md 4.6 の L（2 段目）。
 *
 * - `inventoryTransferCreateAsReadyToShip`（段 `transfer_ready`）と、それが例外になったときの代わりの
 *   `inventoryTransferCreate`（段 `transfer_draft`）に `@idempotent(key: $idempotencyKey)`。違う mutation なので段を分ける
 *   （同じキーで違う中身を送らない）
 * - キーは画面の opKey + 発注の ID + approve、回は「承認を取り消した回数」（rv1…）+ 画面の opRound
 * - 代わりの道の `inventoryTransferMarkAsReadyToShip` は 17 の一覧に無いので付けない（2 章）
 * - **はっきり断られた（userErrors）ときだけ**、前と同じく承認を続ける（Transfer は作られていない）。
 * - 作れたか分からないとき（@idempotent の返事・トップの errors・通信の失敗などの例外）は `uncertain: true` を返す
 *   （呼び出し側は承認を止めて opKey を残す。押し直すと同じキーで、前の送信で作れていれば同じ Transfer が返る）。
 * - 下書きで作り直す代わりの道は、`inventoryTransferCreateAsReadyToShip` が**この版に無いとはっきり分かるとき**だけ通る
 *   （前は例外なら何でも代わりの道へ進んでいた。通信の失敗で進むと、段が違うので別のキーになり、Transfer が 2 つできうる）。
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

/** その mutation がこの版に無い、と分かるエラーか（代わりの道へ進んでよいのはこのときだけ） */
export function isMutationMissingError(e: unknown, mutationName: string): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const name = mutationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(Field|field) '?"?${name}'?"? doesn't exist|${name}.{0,40}(doesn't exist|not exist|undefined field|Cannot query field)|Cannot query field "?'?${name}`).test(msg);
}

const uncertainOf = (label: string, detail: string): OrderTransferResult => ({
  transferId: null,
  error: `${label}の結果が分からない: ${detail}`,
  uncertain: true,
});

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
    if (c.outcome === "uncertain") {
      return uncertainOf("Transfer作成", `${c.idempotencyIssue ?? "GraphQLエラー"}: ${c.message}`);
    }
    if (c.outcome === "rejected") {
      return { transferId: null, error: `Transfer作成エラー: ${formatUserErrors(payload?.userErrors ?? [])}` };
    }
    const transferId = payload?.inventoryTransfer?.id ?? null;
    if (!transferId) {
      return { transferId: null, error: "Transfer ID が取得できませんでした" };
    }
    return { transferId, error: null };
  } catch (readyError) {
    // 通信の失敗など、作れたか分からない例外は承認を止める（代わりの道へ進まない）
    if (!isMutationMissingError(readyError, "inventoryTransferCreateAsReadyToShip")) {
      return uncertainOf("Transfer作成", readyError instanceof Error ? readyError.message : String(readyError));
    }
    // inventoryTransferCreateAsReadyToShip がこの版に無い場合だけ、
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
      if (c.outcome === "uncertain") {
        return uncertainOf("Draft作成", `${c.idempotencyIssue ?? "GraphQLエラー"}: ${c.message}`);
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
      // 下書きを作れたか・印を付けられたか分からない。承認を止める（押し直すと同じキーで同じ下書きが返る）
      return uncertainOf("Draft作成", fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
    }
  }
}
