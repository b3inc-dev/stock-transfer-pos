import { createHash, randomUUID } from "node:crypto";
import database from "../db.server";
import { ensureInventoryActivatedAtLocation } from "./ensure-inventory-activated-server";
import { withGraphQLRetry } from "./graphql-with-retry";
import { buildVariantSearchQuery } from "../../extensions/common/variantSearch.js";
import { DEFAULT_OUTBOUND_REQUEST_POLICY, normalizeOutboundRequestPolicy, outboundQuantity, outboundChunks, validateOutboundActual, validOutboundDate } from "../../extensions/common/outboundRequests.js";
import { OUTBOUND_READY_MUTATION, OUTBOUND_SHIPMENT_MUTATION, OUTBOUND_TRACKING_MUTATION, OUTBOUND_MARK_MUTATION } from "../../extensions/common/outboundTransferMutations.js";
import { shopCalendarDate } from "../../extensions/common/shopHistoryDate.js";

export type RequestAdmin = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
export type RequestLine = { variantId: string; inventoryItemId: string; title: string; sku: string; barcode: string; quantity: number; productTitle?: string; variantTitle?: string; imageUrl?: string; requested?: number; reason?: string };
type Progress = { chunk: number; stage: "prepare" | "transfer" | "shipment" | "tracking" | "mark" | "log"; flight: boolean; chunks: { transferId?: string; shipmentId?: string }[]; tracking: Record<string, string>; policyVersion: number; date: string };
export type RequestRow = { id: string; shop: string; number: string; originId: string; originName: string; destinationId: string; destinationName: string; dueDate: string | null; note: string; lines: RequestLine[]; actualLines: RequestLine[]; status: string; version: number; owner: string | null; claimKey: string | null; operationId: string | null; execution: Progress | null; createdAt: Date; updatedAt: Date; error: string | null };
type Variant = { id: string; displayName: string; title?: string; product?: { title: string }; image?: { url: string } | null; sku: string; barcode: string; inventoryItem: { id: string } };
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));
export const outboundRequestsEnabled = () => process.env.OUTBOUND_REQUESTS_ENABLED === "1";
export function requestError(message: string, status = 400): Error & { status: number } { return Object.assign(new Error(message), { status }); }
function check(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw requestError(message, status); }
export function outboundPublicMessage(error: unknown) {
  return error instanceof Error && ("status" in error || ("code" in error && error.code === "OUTBOUND_VALIDATION")) ? error.message : "処理を確認できません。依頼を読み直し、管理者に確認してください。";
}
export async function requestQuery<T>(admin: RequestAdmin, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const result = await response.json();
  check(response.ok && !result.errors?.length && result.data, "Shopifyへの接続を確認できません。もう一度お試しください", 502);
  return result.data as T;
}
const variantsFields = "id displayName title product { title } image { url } sku barcode inventoryItem { id }";
export async function requestProducts(admin: RequestAdmin, query: string, scan = false) {
  const result = await requestQuery<{ productVariants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean } } }>(withGraphQLRetry(admin), `query OutboundRequestProducts($query:String!){productVariants(first:50,query:$query){nodes{${variantsFields}}pageInfo{hasNextPage}}}`, { query: buildVariantSearchQuery(String(query).slice(0, 100)) });
  if (scan) check(!result.productVariants.pageInfo.hasNextPage, "候補が多いため商品を特定できません。検索して選択してください");
  return result.productVariants.nodes.map(productLine);
}
function productLine(v: Variant) { return { variantId: v.id, inventoryItemId: v.inventoryItem.id, title: v.displayName, productTitle: v.product?.title || v.displayName, variantTitle: v.title === "Default Title" ? "" : v.title || "", imageUrl: v.image?.url || "", sku: v.sku || "", barcode: v.barcode || "", quantity: 0 }; }
export async function canonicalLines(admin: RequestAdmin, lines: RequestLine[]) {
  check(Array.isArray(lines) && lines.length > 0 && lines.length <= 3000, "商品は1〜3000件で登録してください");
  const unique = new Set<string>(), output: RequestLine[] = [];
  for (let i = 0; i < lines.length; i += 50) {
    const group = lines.slice(i, i + 50);
    check(group.every(line => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(line.variantId)), "商品を選択し直してください");
    const result = await requestQuery<{ nodes: (Variant | null)[] }>(withGraphQLRetry(admin), `query OutboundRequestVariants($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{${variantsFields}}}}`, { ids: group.map(line => line.variantId) });
    for (let n = 0; n < group.length; n++) {
      const v = result.nodes[n], input = group[n];
      check(input.reason === undefined || (typeof input.reason === "string" && input.reason.length <= 500), "理由は500文字以内で入力してください");
      check(v?.inventoryItem?.id && !unique.has(v.inventoryItem.id), "削除された商品または重複した商品を確認してください");
      unique.add(v.inventoryItem.id);
      output.push({ ...productLine(v), quantity: outboundQuantity(input.quantity), reason: String(input.reason || "").trim().slice(0, 500) });
    }
  }
  return output;
}
export async function requestLocations(admin: RequestAdmin) {
  const all: { id: string; name: string; isActive: boolean }[] = [];
  let after: string | null = null;
  do {
    const result: { locations: { nodes: typeof all; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await requestQuery(withGraphQLRetry(admin), `query OutboundRequestLocations($after:String){locations(first:100,after:$after){nodes{id name isActive}pageInfo{hasNextPage endCursor}}}`, { after });
    all.push(...result.locations.nodes.filter(row => row.isActive));
    after = result.locations.pageInfo.hasNextPage ? result.locations.pageInfo.endCursor : null;
  } while (after);
  return all;
}
export async function getRequestPolicy(shop: string) {
  const row = await database.outboundRequestSettings.findUnique({ where: { shop } });
  return { version: row?.version || 0, policy: normalizeOutboundRequestPolicy(row?.policy || DEFAULT_OUTBOUND_REQUEST_POLICY) };
}
export async function saveRequestPolicy(shop: string, version: number, policy: unknown) {
  const normalized = normalizeOutboundRequestPolicy(policy);
  if (!version) {
    try { return await database.outboundRequestSettings.create({ data: { shop, policy: normalized } }); }
    catch { throw requestError("設定が変更されました。読み直してください", 409); }
  }
  const result = await database.outboundRequestSettings.updateMany({ where: { shop, version }, data: { policy: normalized, version: { increment: 1 } } });
  check(result.count, "設定が変更されました。読み直してください", 409);
  return getRequestPolicy(shop);
}
export async function getRequest(shop: string, id: string, originId?: string): Promise<RequestRow> {
  const row = await database.outboundRequest.findFirst({ where: { shop, id, ...(originId ? { originId } : {}) } });
  check(row, "出庫依頼が見つかりません。店舗を確認してください", 404);
  return row as unknown as RequestRow;
}
export async function changeRequest(row: RequestRow, actor: string, action: string, changes: Record<string, unknown>): Promise<RequestRow> {
  return database.$transaction(async (tx: Pick<typeof database, "outboundRequest" | "outboundRequestEvent">) => {
    const result = await tx.outboundRequest.updateMany({ where: { id: row.id, shop: row.shop, version: row.version }, data: { ...changes, version: { increment: 1 } } });
    check(result.count, "依頼が更新されました。読み直してから操作してください", 409);
    await tx.outboundRequestEvent.create({ data: { requestId: row.id, actor, action } });
    return await tx.outboundRequest.findUniqueOrThrow({ where: { id: row.id } }) as unknown as RequestRow;
  });
}
export async function saveRequest(shop: string, actor: string, admin: RequestAdmin, input: { id: string; version?: number; originId: string; destinationId: string; lines: RequestLine[]; dueDate: string; note: string; publish: boolean }) {
  check(/^[0-9a-f-]{36}$/i.test(input.id), "依頼番号を確認してください");
  const existing = await database.outboundRequest.findFirst({ where: { id: input.id, shop } });
  if (existing && !input.version) return getRequest(shop, input.id); // Registration retries keep the same ID.
  if (existing) check(["draft", "requested", "working"].includes(existing.status) && existing.version === input.version, "出庫処理中・出庫済み、または更新された依頼は変更できません", 409);
  const locations = await requestLocations(admin);
  const origin = locations.find(row => row.id === input.originId), destination = locations.find(row => row.id === input.destinationId);
  check(origin && destination && origin.id !== destination.id, "異なる出庫元と移動先を選択してください");
  const lines = await canonicalLines(admin, input.lines);
  check(lines.every(row => row.quantity > 0), "依頼数量は1以上で入力してください");
  check(typeof input.note === "string" && input.note.length <= 2000, "備考は2000文字以内で入力してください");
  check(!input.dueDate || validOutboundDate(input.dueDate), "希望日を確認してください");
  if (existing?.status === "working") {
    check(existing.originId === origin.id && existing.destinationId === destination.id, "作業中は出庫元・移動先を変更できません");
    const old = existing.lines as unknown as RequestLine[];
    check(old.every(row => lines.some(next => next.inventoryItemId === row.inventoryItemId && next.quantity >= row.quantity)), "作業中は商品の追加・数量追加だけ可能です");
  }
  const values = { originId: origin.id, originName: origin.name, destinationId: destination.id, destinationName: destination.name, lines: asJson(lines), dueDate: input.dueDate || null, note: input.note, status: existing?.status === "working" ? "working" : input.publish ? "requested" : "draft" };
  if (existing) return changeRequest(existing as unknown as RequestRow, actor, "依頼を更新", values);
  try {
    return await database.outboundRequest.create({ data: { id: input.id, shop, number: `OR-${input.id.toUpperCase()}`, ...values, actualLines: [], createdBy: actor, events: { create: { actor, action: "依頼を作成" } } } }) as unknown as RequestRow;
  } catch (error) { if (await database.outboundRequest.findFirst({ where: { id: input.id, shop } })) return getRequest(shop, input.id); throw error; }
}
export async function shippingSettings(admin: RequestAdmin) {
  const result = await requestQuery<{ currentAppInstallation: { metafield: { value: string } | null } }>(withGraphQLRetry(admin), `query RequestShippingSettings{currentAppInstallation{metafield(namespace:"stock_transfer_pos",key:"settings_v1"){value}}}`);
  const settings = JSON.parse(result.currentAppInstallation.metafield?.value || "{}");
  return { required: settings.outbound?.shippingRequired === true, allowCustomCarrier: settings.outbound?.allowCustomCarrier !== false, carriers: Array.isArray(settings.carriers) ? settings.carriers.filter((row: { company?: string }) => typeof row.company === "string" && row.company).map((row: { label: string; company: string }) => ({ label: row.label, company: row.company })) : [], visibleLocationIds: Array.isArray(settings.visibleLocationIds) ? settings.visibleLocationIds as string[] : [] };
}
export function normalizeRequestTracking(input: Record<string, string> = {}) {
  check(input && typeof input === "object" && !Array.isArray(input), "配送情報を確認してください");
  const result: Record<string, string> = {};
  for (const key of ["trackingNumber", "company", "trackingUrl", "arrivesAt"]) {
    const value = input[key];
    check(value === undefined || (typeof value === "string" && value.length <= 500), "配送情報を確認してください");
    if (value?.trim()) result[key] = value.trim();
  }
  check(!result.trackingUrl || /^https:\/\//.test(result.trackingUrl), "追跡URLはHTTPSで入力してください");
  check(!result.arrivesAt || (validOutboundDate(result.arrivesAt.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T/.test(result.arrivesAt) && Number.isFinite(Date.parse(result.arrivesAt))), "到着予定日を確認してください");
  return result;
}
export async function previewRequest(row: RequestRow, admin: RequestAdmin, actual: RequestLine[], tracking: Record<string, string>) {
  const settings = await getRequestPolicy(row.shop), shipping = await shippingSettings(admin);
  const canonical = await canonicalLines(admin, actual);
  const checked = validateOutboundActual(row.lines, canonical.map(line => ({ ...line, reason: line.reason || "" })), settings.policy);
  const metadata = new Map(canonical.map(line => [line.inventoryItemId, line]));
  const lines = checked.lines.map((line: RequestLine & { requested: number }) => ({ ...line, ...metadata.get(line.inventoryItemId), requested: line.requested, quantity: line.quantity, reason: line.reason })) as RequestLine[];
  const normalized = normalizeRequestTracking(tracking);
  check(!shipping.required || (normalized.company && normalized.trackingNumber), "配送会社と配送番号を入力してください");
  check(shipping.allowCustomCarrier || !normalized.company || shipping.carriers.some((carrier: { company: string }) => carrier.company === normalized.company), "設定されている配送会社を選んでください");
  const token = createHash("sha256").update(JSON.stringify({ id: row.id, version: row.version, policyVersion: settings.version, lines, tracking: normalized })).digest("hex");
  return { lines, differences: checked.differences.map((line: RequestLine & { requested: number; kind: string; delta: number }) => ({ ...line, title: metadata.get(line.inventoryItemId)?.title || line.title, sku: metadata.get(line.inventoryItemId)?.sku || line.sku })), tracking: normalized, policyVersion: settings.version, token };
}
export async function beginRequest(row: RequestRow, actor: string, admin: RequestAdmin, actual: RequestLine[], tracking: Record<string, string>, token: string) {
  check(row.status === "working" && row.owner === actor, "作業中の依頼を開き直してください", 409);
  const preview = await previewRequest(row, admin, actual, tracking);
  check(preview.token === token, "依頼・設定・数量が変わりました。差異をもう一度確認してください", 409);
  const info = await requestQuery<{ shop: { ianaTimezone: string } }>(withGraphQLRetry(admin), "query RequestShopTimezone{shop{ianaTimezone}}");
  const execution: Progress = { chunk: 0, stage: "prepare", flight: false, chunks: outboundChunks(preview.lines).map(() => ({})), tracking: preview.tracking, policyVersion: preview.policyVersion, date: shopCalendarDate(new Date(), info.shop.ianaTimezone) };
  return changeRequest(row, actor, "出庫を開始", { status: "processing", operationId: randomUUID(), actualLines: asJson(preview.lines), execution: asJson(execution), error: null });
}

export async function requestTransferSummary(row: RequestRow, admin: RequestAdmin) {
  const chunks = (row.execution?.chunks ?? []).flatMap(({ transferId, shipmentId }) =>
    transferId ? [{ transferId, shipmentId }] : [],
  );
  const ids = [...new Set(chunks.flatMap(({ transferId, shipmentId }) =>
    shipmentId ? [transferId, shipmentId] : [transferId],
  ))];
  if (!ids.length) return [];
  type ReceiptNode = { __typename: "InventoryTransfer"; id: string; status: string } | {
    __typename: "InventoryShipment";
    id: string;
    lineItemTotalQuantity: number;
    totalAcceptedQuantity: number;
    totalRejectedQuantity: number;
    totalReceivedQuantity: number;
  };
  const { nodes } = await requestQuery<{ nodes: (ReceiptNode | null)[] }>(withGraphQLRetry(admin), `#graphql
    query OutboundRequestReceiving($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        id
        ... on InventoryTransfer { status }
        ... on InventoryShipment {
          lineItemTotalQuantity
          totalAcceptedQuantity
          totalRejectedQuantity
          totalReceivedQuantity
        }
      }
    }
  `, { ids });
  const byId = new Map(nodes.flatMap(node => node ? [[node.id, node] as const] : []));
  return chunks.map(({ transferId, shipmentId }) => {
    const transfer = byId.get(transferId);
    const shipment = shipmentId ? byId.get(shipmentId) : undefined;
    const status = transfer?.__typename === "InventoryTransfer" ? transfer.status : "UNKNOWN";
    if (transfer?.__typename !== "InventoryTransfer" || shipment?.__typename !== "InventoryShipment") {
      return { id: transferId, status, quantities: null };
    }
    const { lineItemTotalQuantity: total, totalAcceptedQuantity: accepted,
      totalRejectedQuantity: rejected, totalReceivedQuantity: processed } = shipment;
    // Shopify's processed quantity includes accepted, rejected and canceled units.
    if (![total, accepted, rejected, processed].every(value => Number.isInteger(value) && value >= 0)
      || accepted + rejected > processed || processed > total) {
      return { id: transferId, status, quantities: null };
    }
    return { id: transferId, status, quantities: {
      total, accepted, rejected, canceled: processed - accepted - rejected, pending: total - processed,
    } };
  });
}

async function mutate(admin: RequestAdmin, query: string, variables: Record<string, unknown>, field: string, entity: string) {
  // Never use the generic 503 retry wrapper for a write: Shopify may already have applied it.
  const response = await admin.graphql(query, { variables });
  const result = await response.json();
  const payload = result.data?.[field];
  if (response.ok && payload?.userErrors?.length && !payload[entity]) throw requestError(payload.userErrors.map((e: { message: string }) => e.message).join(" / "));
  check(response.ok && !result.errors?.length && !payload?.userErrors?.length && payload?.[entity]?.id, "Shopifyの処理結果を確認できません。出庫結果の確認を行ってください", 502);
  return payload[entity] as { id: string; status: string };
}
export async function advanceRequest(row: RequestRow, actor: string, admin: RequestAdmin) {
  check(["processing", "retryable"].includes(row.status) && row.execution && !row.execution.flight, "処理中、または結果の確認が必要です。依頼を読み直してください", 409);
  const progress = structuredClone(row.execution), chunks = outboundChunks(row.actualLines) as RequestLine[][];
  const current = chunks[progress.chunk], references = progress.chunks[progress.chunk];
  check(current && references, "出庫の記録を確認してください", 409);
  const claimed = await changeRequest(row, actor, "出庫処理", { status: "processing", execution: asJson({ ...progress, flight: true }), error: null });
  try {
    const lineItems = current.map(line => ({ inventoryItemId: line.inventoryItemId, quantity: line.quantity }));
    const previousStage = progress.stage;
    if (progress.stage === "prepare") {
      for (const location of [row.originId, row.destinationId]) {
        // This helper can initialize a newly activated level. Never initialize it with the shipping quantity.
        const result = await ensureInventoryActivatedAtLocation(admin, location, lineItems.map(line => ({ ...line, quantity: 0 })));
        check(result.ok, "商品の在庫追跡・ロケーション設定を確認してください");
      }
      progress.stage = "transfer";
    } else if (progress.stage === "transfer") {
      const result = await mutate(admin, OUTBOUND_READY_MUTATION, { input: { originLocationId: row.originId, destinationLocationId: row.destinationId, lineItems, note: `出庫依頼 ${row.number} [outbound-request:${row.operationId}:${progress.chunk}]` } }, "inventoryTransferCreateAsReadyToShip", "inventoryTransfer");
      references.transferId = result.id; progress.stage = "shipment";
    } else if (progress.stage === "shipment") {
      const result = await mutate(admin, OUTBOUND_SHIPMENT_MUTATION, { input: { movementId: references.transferId, lineItems } }, "inventoryShipmentCreate", "inventoryShipment");
      references.shipmentId = result.id; progress.stage = "tracking";
    } else if (progress.stage === "tracking") {
      if (Object.keys(progress.tracking).length) await mutate(admin, OUTBOUND_TRACKING_MUTATION, { id: references.shipmentId, tracking: progress.tracking }, "inventoryShipmentSetTracking", "inventoryShipment");
      progress.stage = "mark";
    } else if (progress.stage === "mark") {
      const result = await mutate(admin, OUTBOUND_MARK_MUTATION, { id: references.shipmentId }, "inventoryShipmentMarkInTransit", "inventoryShipment");
      check(result.status === "IN_TRANSIT", "発送状態を確認できません", 502);
      progress.stage = "log";
    } else if (progress.stage === "log") {
      await database.$transaction(current.map(line => {
        const idempotencyKey = `outbound-request:${row.id}:${line.inventoryItemId}`;
        return database.inventoryChangeLog.upsert({ where: { shop_idempotencyKey: { shop: row.shop, idempotencyKey } }, update: {}, create: { shop: row.shop, date: progress.date, inventoryItemId: line.inventoryItemId, variantId: line.variantId, sku: line.sku, locationId: row.originId, locationName: row.originName, activity: "outbound_transfer", delta: -line.quantity, quantityAfter: null, sourceType: "outbound_transfer", sourceId: references.transferId, idempotencyKey, note: `出庫依頼 ${row.number}${line.reason ? ` / ${line.reason}` : ""}` } });
      }));
      progress.chunk++; progress.stage = "prepare";
    }
    progress.flight = false;
    return await changeRequest(claimed, actor, previousStage === "log" ? "出庫を記録" : "出庫処理を記録", { execution: asJson(progress), status: progress.chunk === chunks.length ? "completed" : "processing", ...(progress.chunk === chunks.length ? { completedAt: new Date() } : {}) });
  } catch (error) {
    // prepare/log are safely repeatable. A write without a definite rejection is never blindly retried.
    const safe = ["prepare", "log"].includes(row.execution.stage) || (error instanceof Error && "status" in error && error.status === 400);
    return changeRequest(claimed, actor, "出庫結果の確認が必要", { status: safe ? "retryable" : "uncertain", execution: asJson({ ...row.execution, flight: false }), error: safe && error instanceof Error ? error.message : "出庫の結果を確認できません。結果確認を行い、再作成しないでください。" });
  }
}

/** Read-only reconciliation; absent/ambiguous resources never authorize another create. */
export async function reconcileRequest(row: RequestRow, actor: string, admin: RequestAdmin) {
  check(row.execution && ["uncertain", "processing"].includes(row.status), "結果確認の対象ではありません", 409);
  check(!row.execution.flight || Date.now() - row.updatedAt.getTime() > 120000, "処理が続いています。時間をおいて読み直してください", 409);
  const progress = structuredClone(row.execution), reference = progress.chunks[progress.chunk];
  check(reference, "出庫の記録を確認してください");
  const expected = outboundChunks(row.actualLines)[progress.chunk] as RequestLine[];
  if (["prepare", "log"].includes(progress.stage)) {
    progress.flight = false;
    return changeRequest(row, actor, "保存処理を再開", { status: "retryable", execution: asJson(progress) });
  }
  if (progress.stage === "transfer") {
    let after: string | null = null;
    const matches: { id: string }[] = [];
    do {
      const result: { inventoryTransfers: { nodes: { id: string; note: string; origin: { location: { id: string } }; destination: { location: { id: string } } }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await requestQuery(withGraphQLRetry(admin), "query RequestRecoverTransfers($after:String){inventoryTransfers(first:100,after:$after){nodes{id note origin{location{id}} destination{location{id}}}pageInfo{hasNextPage endCursor}}}", { after });
      matches.push(...result.inventoryTransfers.nodes.filter(item => item.note?.includes(`[outbound-request:${row.operationId}:${progress.chunk}]`) && item.origin?.location?.id === row.originId && item.destination?.location?.id === row.destinationId));
      after = result.inventoryTransfers.pageInfo.hasNextPage ? result.inventoryTransfers.pageInfo.endCursor : null;
    } while (after);
    check(matches.length === 1, "作成結果を特定できません。Shopifyの移動履歴を管理者が確認してください。新しく出庫し直さないでください", 409);
    reference.transferId = matches[0].id; progress.stage = "shipment";
  } else {
    const result = await requestQuery<{ inventoryTransfer: { shipments: { nodes: { id: string; status: string; tracking: Record<string, string> | null; lineItems: { nodes: { quantity: number; inventoryItem: { id: string } }[] } }[] } } }>(withGraphQLRetry(admin), `query RequestRecoverShipment($id:ID!){inventoryTransfer(id:$id){shipments(first:10){nodes{id status tracking{trackingNumber company trackingUrl arrivesAt}lineItems(first:250){nodes{quantity inventoryItem{id}}}}}}}`, { id: reference.transferId });
    const candidates = result.inventoryTransfer?.shipments.nodes.filter(item => item.lineItems.nodes.length === expected.length && expected.every(line => item.lineItems.nodes.some(node => node.inventoryItem.id === line.inventoryItemId && node.quantity === line.quantity))) || [];
    const shipment = reference.shipmentId ? candidates.find(item => item.id === reference.shipmentId) : candidates.length === 1 ? candidates[0] : null;
    check(shipment, "配送結果を特定できません。管理者がShopifyの配送履歴を確認してください", 409);
    if (progress.stage === "shipment") { reference.shipmentId = shipment.id; progress.stage = "tracking"; }
    else if (progress.stage === "tracking") {
      check(Object.entries(progress.tracking).every(([key, value]) => String(shipment.tracking?.[key] || "").startsWith(value)), "配送情報の反映を確認できません。管理者に確認してください", 409);
      progress.stage = "mark";
    } else {
      check(["IN_TRANSIT", "PARTIALLY_RECEIVED", "RECEIVED"].includes(shipment.status), "発送結果を確認できません。管理者がShopifyで確認してください", 409);
      progress.stage = "log";
    }
  }
  progress.flight = false;
  return changeRequest(row, actor, "出庫結果を照合", { status: "processing", execution: asJson(progress), error: null });
}
