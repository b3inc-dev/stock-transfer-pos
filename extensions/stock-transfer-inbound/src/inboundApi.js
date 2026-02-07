import { adminGraphql, assertNoUserErrors } from "./inboundHelpers.js";

const SHOPIFY = globalThis?.shopify ?? {};

const SETTINGS_NS = "stock_transfer_pos";
const SETTINGS_KEY = "settings_v1";

function safeParseSettings(raw, defaultVal) {
  if (typeof raw !== "string" || !raw) return defaultVal;
  try {
    const p = JSON.parse(raw);
    return p?.version === 1 ? p : defaultVal;
  } catch {
    return defaultVal;
  }
}

const DEFAULT_SETTINGS = {
  version: 1,
  inbound: { listInitialLimit: 100 },
  productList: { initialLimit: 250 },
  searchList: { initialLimit: 50 },
};

export async function fetchSettings() {
  const gql = `#graphql
    query InboundSettings {
      currentAppInstallation {
        metafield(namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { value type }
      }
    }`;
  try {
    const data = await adminGraphql(gql);
    const raw = data?.currentAppInstallation?.metafield?.value ?? null;
    const parsed = safeParseSettings(raw, DEFAULT_SETTINGS);
    return parsed && parsed.version === 1 ? parsed : DEFAULT_SETTINGS;
  } catch (e) {
    console.error("[inbound fetchSettings] error:", e);
    return DEFAULT_SETTINGS;
  }
}

export async function fetchPendingTransfersForDestination(destinationLocationGid, opts = {}) {
  const first = Math.max(1, Math.min(250, Number(opts.first ?? 50)));
  const query = `#graphql
    query PendingTransfers($first: Int!) {
      inventoryTransfers(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id name status note dateCreated totalQuantity receivedQuantity
          origin { name location { id name } }
          destination { name location { id name } }
          shipments(first: 10) { nodes { id status tracking { trackingNumber company trackingUrl arrivesAt } } }
        }
      }
    }`;
  const data = await adminGraphql(query, { first });
  const nodes = data?.inventoryTransfers?.nodes ?? [];
  const filtered = nodes.filter((t) => {
    const destId = t?.destination?.location?.id;
    if (destinationLocationGid && destId !== destinationLocationGid) return false;
    if ((t?.totalQuantity ?? 0) > 0 && (t?.receivedQuantity ?? 0) >= (t?.totalQuantity ?? 0)) return false;
    if ((t?.shipments?.nodes ?? []).length === 0) return false;
    return true;
  });
  return filtered.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    note: t.note ?? "",
    dateCreated: t.dateCreated ?? null,
    originName: t.origin?.name ?? t.origin?.location?.name ?? "",
    originLocationId: t.origin?.location?.id ?? null,
    destinationName: t.destination?.name ?? t.destination?.location?.name ?? "",
    destinationLocationId: t.destination?.location?.id ?? null,
    totalQuantity: t.totalQuantity ?? 0,
    receivedQuantity: t.receivedQuantity ?? 0,
    shipments: (t.shipments?.nodes ?? []).map((s) => ({ id: s.id, status: s.status, tracking: s.tracking ?? null })),
  }));
}

export async function fetchTransfersForDestinationAll(destinationLocationGid, opts = {}) {
  const after = opts?.after || null;
  const first = Math.max(1, Math.min(250, Number(opts.first ?? 100)));
  const query = `#graphql
    query TransfersAll($first: Int!, $after: String) {
      inventoryTransfers(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id name status note dateCreated totalQuantity receivedQuantity
          origin { name location { id name } }
          destination { name location { id name } }
          shipments(first: 10) { nodes { id status tracking { trackingNumber company trackingUrl arrivesAt } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  const data = await adminGraphql(query, { first, after });
  const nodes = data?.inventoryTransfers?.nodes ?? [];
  const pageInfo = data?.inventoryTransfers?.pageInfo || { hasNextPage: false, endCursor: null };
  const filtered = nodes.filter((t) => {
    const destId = t?.destination?.location?.id;
    if (destinationLocationGid && destId !== destinationLocationGid) return false;
    if ((t?.shipments?.nodes ?? []).length === 0) return false;
    return true;
  });
  const transfers = filtered.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    note: t.note ?? "",
    dateCreated: t.dateCreated ?? null,
    originName: t.origin?.name ?? t.origin?.location?.name ?? "",
    originLocationId: t.origin?.location?.id ?? null,
    destinationName: t.destination?.name ?? t.destination?.location?.name ?? "",
    destinationLocationId: t.destination?.location?.id ?? null,
    totalQuantity: t.totalQuantity ?? 0,
    receivedQuantity: Number(t.receivedQuantity ?? 0),
    overQuantity: 0,
    receivedQuantityDisplay: Number(t.receivedQuantity ?? 0),
    shipments: (t.shipments?.nodes ?? []).map((s) => ({ id: s.id, status: s.status, tracking: s.tracking ?? null })),
  }));
  return { transfers, pageInfo };
}

export async function fetchInventoryShipmentEnriched(id, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const signal = opts?.signal;
  const after = opts?.after || null;
  const first = Math.max(1, Math.min(250, Number(opts.first ?? 250)));
  const shipmentId = String(id || "").trim();
  if (!shipmentId) throw new Error("配送 ID が空です");

  // REFERENCE（tile）同様: includeImages が true のときは画像付きクエリで imageUrl を取得
  if (includeImages) {
    try {
      const qImg = `#graphql
        query GetShipmentEnrichedWithImages($id: ID!, $first: Int!, $after: String) {
          inventoryShipment(id: $id) {
            id status tracking { trackingNumber company trackingUrl arrivesAt }
            lineItems(first: $first, after: $after) {
              nodes {
                id quantity acceptedQuantity rejectedQuantity unreceivedQuantity
                inventoryItem {
                  id
                  variant {
                    id sku barcode title
                    image { url }
                    product { title featuredImage { url } }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`;
      const d = await adminGraphql(qImg, { id: shipmentId, first, after }, { signal });
      const s = d?.inventoryShipment;
      if (!s?.id) throw new Error("配送が見つかりませんでした");
      const lineItems = (s.lineItems?.nodes ?? []).map((li) => {
        const v = li.inventoryItem?.variant;
        const productTitle = String(v?.product?.title || "").trim();
        const variantTitle = String(v?.title || "").trim();
        const imageUrl = v?.image?.url ?? v?.product?.featuredImage?.url ?? "";
        return {
          id: li.id,
          quantity: Number(li.quantity ?? 0),
          acceptedQuantity: Number(li.acceptedQuantity ?? 0),
          rejectedQuantity: Number(li.rejectedQuantity ?? 0),
          unreceivedQuantity: Number(li.unreceivedQuantity ?? 0),
          inventoryItemId: li.inventoryItem?.id ?? null,
          variantId: v?.id ?? null,
          sku: v?.sku ?? "",
          barcode: v?.barcode ?? "",
          productTitle,
          variantTitle,
          title: productTitle && variantTitle ? `${productTitle} / ${variantTitle}` : (variantTitle || productTitle || v?.sku || li.inventoryItem?.id || "(unknown)"),
          imageUrl: String(imageUrl || "").trim(),
        };
      });
      return { id: s.id, status: s.status, tracking: s.tracking ?? null, lineItems, pageInfo: s.lineItems?.pageInfo || { hasNextPage: false, endCursor: null } };
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/doesn't exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
    }
  }

  const qNoImg = `#graphql
    query GetShipmentEnrichedNoImages($id: ID!, $first: Int!, $after: String) {
      inventoryShipment(id: $id) {
        id status tracking { trackingNumber company trackingUrl arrivesAt }
        lineItems(first: $first, after: $after) {
          nodes {
            id quantity acceptedQuantity rejectedQuantity unreceivedQuantity
            inventoryItem {
              id
              variant { id sku barcode title product { title } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
  const d = await adminGraphql(qNoImg, { id: shipmentId, first, after }, { signal });
  const s = d?.inventoryShipment;
  if (!s?.id) throw new Error("配送が見つかりませんでした");
  const lineItems = (s.lineItems?.nodes ?? []).map((li) => {
    const v = li.inventoryItem?.variant;
    const productTitle = String(v?.product?.title || "").trim();
    const variantTitle = String(v?.title || "").trim();
    return {
      id: li.id,
      quantity: Number(li.quantity ?? 0),
      acceptedQuantity: Number(li.acceptedQuantity ?? 0),
      rejectedQuantity: Number(li.rejectedQuantity ?? 0),
      unreceivedQuantity: Number(li.unreceivedQuantity ?? 0),
      inventoryItemId: li.inventoryItem?.id ?? null,
      variantId: v?.id ?? null,
      sku: v?.sku ?? "",
      barcode: v?.barcode ?? "",
      productTitle,
      variantTitle,
      title: productTitle && variantTitle ? `${productTitle} / ${variantTitle}` : (variantTitle || productTitle || v?.sku || li.inventoryItem?.id || "(unknown)"),
      imageUrl: "",
    };
  });
  return { id: s.id, status: s.status, tracking: s.tracking ?? null, lineItems, pageInfo: s.lineItems?.pageInfo || { hasNextPage: false, endCursor: null } };
}

export async function receiveShipmentWithFallbackV2({ shipmentId, items }) {
  const clean = (items || [])
    .map((x) => ({ shipmentLineItemId: x.shipmentLineItemId || x.id || x.lineItemId || null, quantity: Number(x.quantity || 0), reason: String(x.reason || "ACCEPTED").trim().toUpperCase() }))
    .filter((x) => x.shipmentLineItemId && x.quantity > 0);
  if (clean.length === 0) return null;
  try {
    const m1 = `#graphql mutation ReceiveItems($id: ID!, $items: [InventoryShipmentReceiveItemInput!]!) { inventoryShipmentReceiveItems(id: $id, items: $items) { inventoryShipment { id status } userErrors { field message } } }`;
    const d1 = await adminGraphql(m1, { id: shipmentId, items: clean });
    assertNoUserErrors(d1?.inventoryShipmentReceiveItems, "inventoryShipmentReceiveItems");
    return d1?.inventoryShipmentReceiveItems?.inventoryShipment ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/doesn't exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
  }
  try {
    const m2 = `#graphql mutation Receive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!]!) { inventoryShipmentReceive(id: $id, lineItems: $lineItems) { inventoryShipment { id status } userErrors { field message } } }`;
    const d2 = await adminGraphql(m2, { id: shipmentId, lineItems: clean });
    assertNoUserErrors(d2?.inventoryShipmentReceive, "inventoryShipmentReceive");
    return d2?.inventoryShipmentReceive?.inventoryShipment ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/reason/i.test(msg) && /(not defined by type|Unknown field|invalid)/i.test(msg)) {
      const noReason = clean.map(({ shipmentLineItemId, quantity }) => ({ shipmentLineItemId, quantity }));
      const m2b = `#graphql mutation Receive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!]!) { inventoryShipmentReceive(id: $id, lineItems: $lineItems) { inventoryShipment { id status } userErrors { field message } } }`;
      const d2b = await adminGraphql(m2b, { id: shipmentId, lineItems: noReason });
      assertNoUserErrors(d2b?.inventoryShipmentReceive, "inventoryShipmentReceive");
      return d2b?.inventoryShipmentReceive?.inventoryShipment ?? null;
    }
    throw e;
  }
}

export async function adjustInventoryAtLocationWithFallback({ locationId, deltas, referenceDocumentUri }) {
  const changes = (deltas ?? []).filter((x) => x?.inventoryItemId && Number(x?.delta || 0) !== 0).map((x) => ({ inventoryItemId: x.inventoryItemId, delta: Number(x.delta) }));
  if (!locationId || changes.length === 0) return null;
  
  // referenceDocumentUriを生成（転送IDが指定されている場合）
  const uri = referenceDocumentUri ? `gid://stock-transfer-pos/InboundTransfer/${referenceDocumentUri}` : null;
  
  try {
    const input = { reason: "correction", name: "available", changes: changes.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId, delta: c.delta })) };
    // referenceDocumentUriが指定されている場合は追加
    if (uri) {
      input.referenceDocumentUri = uri;
    }
    const m1 = `#graphql mutation Adjust($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message } } }`;
    const d1 = await adminGraphql(m1, { input });
    assertNoUserErrors(d1?.inventoryAdjustQuantities, "inventoryAdjustQuantities");
    return d1?.inventoryAdjustQuantities?.inventoryAdjustmentGroup ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/doesn't exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
  }
  const currentMap = new Map();
  for (const c of changes) {
    const q = `#graphql query Cur($id: ID!, $loc: ID!) { inventoryItem(id: $id) { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }`;
    const d = await adminGraphql(q, { id: c.inventoryItemId, loc: locationId });
    const cur = d?.inventoryItem?.inventoryLevel?.quantities?.find((x) => x.name === "available")?.quantity ?? 0;
    currentMap.set(c.inventoryItemId, Number(cur || 0));
  }
  const quantities = changes.map((c) => {
    const cur = currentMap.get(c.inventoryItemId) ?? 0;
    return { inventoryItemId: c.inventoryItemId, locationId, quantity: cur + c.delta, compareQuantity: cur };
  });
  const input2 = { name: "available", reason: "correction", quantities };
  // referenceDocumentUriが指定されている場合は追加（fallbackでも設定）
  if (uri) {
    input2.referenceDocumentUri = uri;
  }
  const m2 = `#graphql mutation Set($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message } } }`;
  const d2 = await adminGraphql(m2, { input: input2 });
  assertNoUserErrors(d2?.inventorySetQuantities, "inventorySetQuantities");
  return d2?.inventorySetQuantities?.inventoryAdjustmentGroup ?? null;
}

export async function ensureInventoryActivatedAtLocation({ locationId, inventoryItemIds }) {
  const ids = (Array.isArray(inventoryItemIds) ? inventoryItemIds : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!locationId || ids.length === 0) return { ok: true, activated: [], errors: [] };
  const activated = [];
  const errors = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const q = await adminGraphql(
        `#graphql query Check($ids: [ID!]!, $locationId: ID!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id tracked inventoryLevel(locationId: $locationId) { id }
            }
          }
        }`,
        { ids: chunk, locationId }
      );
      const nodes = Array.isArray(q?.nodes) ? q.nodes : [];
      for (const node of nodes) {
        const inventoryItemId = String(node?.id || "").trim();
        if (!inventoryItemId) continue;
        const hasLevel = !!node?.inventoryLevel?.id;
        if (hasLevel) {
          activated.push({ inventoryItemId, locationId });
          continue;
        }
        try {
          await adminGraphql(
            `#graphql mutation Activate($inventoryItemId: ID!, $locationId: ID!) {
              inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                inventoryLevel { id }
                userErrors { field message }
              }
            }`,
            { inventoryItemId, locationId }
          );
          activated.push({ inventoryItemId, locationId });
        } catch (e) {
          errors.push({ inventoryItemId, message: String(e?.message || e) });
        }
      }
    } catch (e) {
      for (const id of chunk) errors.push({ inventoryItemId: id, message: String(e?.message || e) });
    }
  }
  return { ok: errors.length === 0, activated, errors };
}

const INBOUND_DRAFT_PREFIX_V2 = "stock_transfer_pos_inbound_draft_v2";
const INBOUND_DRAFT_PREFIX_V1 = "stock_transfer_pos_inbound_draft_v1";

export function inboundDraftKeyV2({ locationGid, transferId }) {
  return `${INBOUND_DRAFT_PREFIX_V2}:${String(locationGid || "").trim()}:${String(transferId || "").trim()}`;
}

export function inboundDraftKeyV1({ locationGid, shipmentId }) {
  return `${INBOUND_DRAFT_PREFIX_V1}:${String(locationGid || "").trim()}:${String(shipmentId || "").trim()}`;
}

function inboundDraftKey({ locationGid, transferId, shipmentId }) {
  const tid = String(transferId || "").trim();
  if (tid) return inboundDraftKeyV2({ locationGid, transferId: tid });
  return inboundDraftKeyV1({ locationGid, shipmentId });
}

export async function loadInboundDraft({ locationGid, transferId, shipmentId }) {
  const tid = String(transferId || "").trim();
  const sid = String(shipmentId || "").trim();
  if (tid) {
    const keyV2 = inboundDraftKeyV2({ locationGid, transferId: tid });
    try {
      if (SHOPIFY?.storage?.get) {
        const got = await SHOPIFY.storage.get(keyV2);
        const parsed = got?.[keyV2] ?? got ?? null;
        if (parsed && String(parsed.transferId || "") === tid) return parsed;
      }
    } catch {}
    try {
      const raw = localStorage.getItem(keyV2);
      if (raw) { const parsed = JSON.parse(raw); if (parsed && String(parsed.transferId || "") === tid) return parsed; }
    } catch {}
  }
  if (sid) {
    const keyV1 = inboundDraftKeyV1({ locationGid, shipmentId: sid });
    try {
      if (SHOPIFY?.storage?.get) {
        const got = await SHOPIFY.storage.get(keyV1);
        const parsed = got?.[keyV1] ?? got ?? null;
        if (parsed && String(parsed.shipmentId || "") === sid) return parsed;
      }
    } catch {}
    try {
      const raw = localStorage.getItem(keyV1);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || String(parsed.shipmentId || "") !== sid) return null;
      return parsed;
    } catch {}
  }
  return null;
}

export async function saveInboundDraft({ locationGid, transferId, shipmentId, payload }) {
  const key = inboundDraftKey({ locationGid, transferId, shipmentId });
  try {
    if (SHOPIFY?.storage?.set) { await SHOPIFY.storage.set(key, payload); return true; }
  } catch {}
  try { localStorage.setItem(key, JSON.stringify(payload)); return true; } catch {}
  return false;
}

export async function clearInboundDraft({ locationGid, transferId, shipmentId }) {
  const tid = String(transferId || "").trim();
  if (tid) {
    const keyV2 = inboundDraftKeyV2({ locationGid, transferId: tid });
    try { if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(keyV2); } catch {}
    try { localStorage.removeItem(keyV2); } catch {}
  }
  const sid = String(shipmentId || "").trim();
  if (sid) {
    const keyV1 = inboundDraftKeyV1({ locationGid, shipmentId: sid });
    try { if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(keyV1); } catch {}
    try { localStorage.removeItem(keyV1); } catch {}
  }
}

const INBOUND_AUDIT_NS = "stock_transfer_pos";
const INBOUND_AUDIT_KEY = "inbound_audit_v1";
const INBOUND_AUDIT_MAX = 50;

export async function readInboundAuditLog() {
  const q = `#graphql query AuditGet { currentAppInstallation { id metafield(namespace: "${INBOUND_AUDIT_NS}", key: "${INBOUND_AUDIT_KEY}") { id value type } } }`;
  const d = await adminGraphql(q, {});
  const raw = d?.currentAppInstallation?.metafield?.value || "[]";
  try { return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []; } catch { return []; }
}

export function buildInboundOverIndex_(auditEntries, { locationId } = {}) {
  const idx = new Map();
  (auditEntries || []).forEach((e) => {
    const sid = String(e?.shipmentId || "").trim();
    const loc = String(e?.locationId || "").trim();
    if (!sid) return;
    if (locationId && loc && loc !== String(locationId || "").trim()) return;
    const overArr = Array.isArray(e?.over) ? e.over : [];
    const sum = overArr.reduce((a, x) => a + Math.max(0, Math.floor(Number(x?.qty ?? x?.overQty ?? x?.delta ?? 0))), 0);
    if (sum > 0) idx.set(sid, (idx.get(sid) || 0) + sum);
  });
  return idx;
}

export function buildInboundExtrasIndex_(auditEntries, { locationId } = {}) {
  const idx = new Map();
  (auditEntries || []).forEach((e) => {
    const sid = String(e?.shipmentId || "").trim();
    const loc = String(e?.locationId || "").trim();
    if (!sid) return;
    if (locationId && loc && loc !== String(locationId || "").trim()) return;
    const extrasArr = Array.isArray(e?.extras) ? e.extras : [];
    const sum = extrasArr.reduce((a, x) => a + Math.max(0, Math.floor(Number(x?.qty ?? x?.delta ?? x?.receiveQty ?? 0))), 0);
    if (sum > 0) idx.set(sid, (idx.get(sid) || 0) + sum);
  });
  return idx;
}

export function buildInboundOverItemIndex_(auditEntries, { locationId, shipmentId } = {}) {
  const idx = new Map();
  const sidNeedle = String(shipmentId || "").trim();
  const locNeedle = String(locationId || "").trim();
  (auditEntries || []).forEach((e) => {
    const sid = String(e?.shipmentId || "").trim();
    const loc = String(e?.locationId || "").trim();
    if (!sid) return;
    if (sidNeedle && sid !== sidNeedle) return;
    if (locNeedle && loc && loc !== locNeedle) return;
    (Array.isArray(e?.over) ? e.over : []).forEach((x) => {
      const inventoryItemId = String(x?.inventoryItemId || "").trim();
      if (!inventoryItemId) return;
      const n = Math.max(0, Math.floor(Number(x?.overQty ?? x?.qty ?? x?.delta ?? 0)));
      if (n > 0) idx.set(inventoryItemId, (idx.get(inventoryItemId) || 0) + n);
    });
  });
  return idx;
}

export async function buildInboundRejectedIndex_(shipmentIds) {
  const idx = new Map(); // shipmentId -> rejectedSum
  if (!Array.isArray(shipmentIds) || shipmentIds.length === 0) return idx;

  // バッチ処理でshipmentsのlineItemsを取得（最大10件ずつ）
  const batchSize = 10;
  for (let i = 0; i < shipmentIds.length; i += batchSize) {
    const batch = shipmentIds.slice(i, i + batchSize);
    try {
      // 各shipmentのlineItemsからrejectedQuantityを集計
      await Promise.all(
        batch.map(async (shipmentId) => {
          try {
            const shipment = await fetchInventoryShipmentEnriched(shipmentId, {
              includeImages: false,
            });
            if (!shipment?.lineItems) return;

            const rejectedSum = (shipment.lineItems || []).reduce((sum, li) => {
              const rejected = Math.max(0, Number(li.rejectedQuantity ?? 0));
              return sum + rejected;
            }, 0);

            if (rejectedSum > 0) {
              idx.set(String(shipmentId), rejectedSum);
            }
          } catch (e) {}
        })
      );
    } catch (e) {}
  }

  return idx;
}

export function mergeInboundOverIntoTransfers_(transfers, overByShipmentId, extrasByShipmentId, rejectedByShipmentId) {
  const arr = Array.isArray(transfers) ? transfers : [];
  const overMap = overByShipmentId instanceof Map ? overByShipmentId : new Map();
  const extrasMap = extrasByShipmentId instanceof Map ? extrasByShipmentId : new Map();
  const rejectedMap = rejectedByShipmentId instanceof Map ? rejectedByShipmentId : new Map();
  return arr.map((t) => {
    const shipments = Array.isArray(t?.shipments) ? t.shipments : [];
    const overQuantity = shipments.reduce((a, s) => a + (s?.id ? Number(overMap.get(s.id) || 0) : 0), 0);
    const extrasQuantity = shipments.reduce((a, s) => a + (s?.id ? Number(extrasMap.get(s.id) || 0) : 0), 0);
    const rejectedQuantity = shipments.reduce((a, s) => a + (s?.id ? Number(rejectedMap.get(s.id) || 0) : 0), 0);
    const receivedQuantity = Number(t?.receivedQuantity ?? 0);
    const receivedQuantityDisplay = receivedQuantity - Number(rejectedQuantity || 0) + Number(extrasQuantity || 0);
    return { ...t, overQuantity, extrasQuantity, rejectedQuantity, receivedQuantityDisplay };
  });
}

export async function appendInboundAuditLog({ locationId, shipmentId, reason, note, over, extras }) {
  const q = `#graphql query AuditGet { currentAppInstallation { id metafield(namespace: "${INBOUND_AUDIT_NS}", key: "${INBOUND_AUDIT_KEY}") { id value type } } }`;
  const d = await adminGraphql(q, {});
  const app = d?.currentAppInstallation;
  if (!app?.id) throw new Error("currentAppInstallation が取得できませんでした");
  let cur = [];
  try { cur = JSON.parse(app?.metafield?.value || "[]"); } catch {}
  if (!Array.isArray(cur)) cur = [];
  const entry = { at: new Date().toISOString(), locationId, shipmentId, reason: String(reason || ""), note: String(note || ""), over: Array.isArray(over) ? over : [], extras: Array.isArray(extras) ? extras : [] };
  const next = [entry, ...cur].slice(0, INBOUND_AUDIT_MAX);
  const m = `#graphql mutation AuditSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`;
  const r = await adminGraphql(m, { metafields: [{ ownerId: app.id, namespace: INBOUND_AUDIT_NS, key: INBOUND_AUDIT_KEY, type: "json", value: JSON.stringify(next) }] });
  assertNoUserErrors(r?.metafieldsSet, "metafieldsSet");
}

export function buildInboundNoteLine_({ shipmentId, locationId, finalize, note, over, extras, inventoryAdjustments }) {
  const at = new Date();
  const dateStr = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const lines = ["[POS入庫処理] " + dateStr, finalize ? "状態: 完了" : "状態: 一部入庫"];
  if (note) lines.push("メモ: " + note);
  if (Array.isArray(over) && over.length > 0) {
    lines.push("予定超過: " + over.length + "件");
    over.forEach((o) => { const title = String(o?.title || o?.inventoryItemId || "不明").trim(); const sku = String(o?.sku || "").trim(); const qty = Number(o?.qty || 0); lines.push(sku ? `  - ${title} (SKU: ${sku}): +${qty}` : `  - ${title}: +${qty}`); });
  }
  if (Array.isArray(extras) && extras.length > 0) {
    lines.push("予定外入庫: " + extras.length + "件");
    extras.forEach((e) => { const titleRaw = String(e?.title || e?.inventoryItemId || "不明").trim(); const sku = String(e?.sku || "").trim(); const qty = Number(e?.qty || 0); lines.push(`  - ${titleRaw}${sku ? ", SKU: " + sku : ""}, 数量: ${qty}`); });
  }
  if (Array.isArray(inventoryAdjustments) && inventoryAdjustments.length > 0) {
    lines.push("在庫調整履歴:");
    inventoryAdjustments.forEach((adj) => { const loc = String(adj?.locationName || adj?.locationId || "不明").trim(); const title = String(adj?.title || adj?.inventoryItemId || "不明").trim(); const delta = Number(adj?.delta || 0); lines.push(`  - ${loc}: ${title} ${delta > 0 ? "+" : ""}${delta}`); });
  }
  return lines.join("\n");
}

function buildVariantSearchQuery_(raw) {
  const q = String(raw || "").trim();
  if (!q) return "";
  const isDigitsOnly = /^\d+$/.test(q);
  const hasAlpha = /[A-Za-z]/.test(q);
  const hasSkuLike = /[-_./]/.test(q);
  const parts = [];
  if (isDigitsOnly) {
    if (q.length >= 8) parts.push(`barcode:${q}`);
    else parts.push(q);
  }
  if (hasAlpha || hasSkuLike) parts.push(`sku:${q}`);
  parts.push(q);
  return [...new Set(parts)].join(" OR ");
}

export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const first = Math.max(10, Math.min(50, Number(opts?.first) || 50));
  const query = buildVariantSearchQuery_(q);
  if (!query) return [];
  const gql = includeImages
    ? `#graphql
      query GetVariants($first: Int!, $query: String!) {
        productVariants(first: $first, query: $query) {
          nodes {
            id title sku barcode image { url }
            inventoryItem { id }
            product { title featuredImage { url } }
          }
        }
      }`
    : `#graphql
      query GetVariants($first: Int!, $query: String!) {
        productVariants(first: $first, query: $query) {
          nodes {
            id title sku barcode inventoryItem { id } product { title }
          }
        }
      }`;
  const data = await adminGraphql(gql, { first, query }, opts);
  const nodes = data?.productVariants?.nodes ?? [];
  return nodes.map((n) => ({
    variantId: n.id,
    inventoryItemId: n.inventoryItem?.id,
    productTitle: n.product?.title ?? "",
    variantTitle: n.title ?? "",
    sku: n.sku ?? "",
    barcode: n.barcode ?? "",
    imageUrl: includeImages ? (n.image?.url ?? n.product?.featuredImage?.url ?? "") : "",
  }));
}

/** バリアントの指定ロケーション在庫（available）を取得。Modal_REFERENCE 互換。 */
export async function fetchVariantAvailable({ variantGid, locationGid }, opts = {}) {
  const query = `#graphql
    query VariantInv($variantId: ID!, $locationId: ID!) {
      productVariant(id: $variantId) {
        inventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }`;
  const data = await adminGraphql(query, { variantId: variantGid, locationId: locationGid }, opts);
  const level = data?.productVariant?.inventoryItem?.inventoryLevel;
  const available = level?.quantities?.find((x) => x.name === "available")?.quantity ?? null;
  return { inventoryItemId: data?.productVariant?.inventoryItem?.id, available };
}

const INVENTORY_TRANSFER_NOTE_QUERY = `
  query TransferNote($id: ID!) {
    inventoryTransfer(id: $id) {
      id note status name
    }
  }
`;

const INVENTORY_TRANSFER_EDIT_NOTE_MUTATION = `
  mutation TransferEditNote($id: ID!, $input: InventoryTransferEditInput!) {
    inventoryTransferEdit(id: $id, input: $input) {
      inventoryTransfer { id note status }
      userErrors { field message }
    }
  }
`;

export async function appendInventoryTransferNote_({ transferId, line, maxLen = 5000, processLogCallback }) {
  if (!transferId || !line) return false;
  const toast = (m) => SHOPIFY?.toast?.show?.(String(m));
  try {
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] 開始: transferId=${transferId}`);
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] 現在のメモを取得中...`);
    const q1 = await adminGraphql(INVENTORY_TRANSFER_NOTE_QUERY, { id: transferId });
    if (!q1?.inventoryTransfer) {
      const msg = "Transferが見つかりません";
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] エラー: ${msg}`);
      toast(`メモ保存エラー: ${msg}`);
      return false;
    }
    const transfer = q1.inventoryTransfer;
    const status = String(transfer.status || "").trim();
    const current = String(transfer.note || "").trim();
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] 取得完了: status=${status}, currentNoteLength=${current.length}`);
    if (status && !["DRAFT", "READY_TO_SHIP", "IN_TRANSIT"].includes(status)) {
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] 警告: ステータスが編集可能でない可能性 (status=${status})`);
    }
    const merged = current ? `${current}\n\n${String(line)}` : String(line);
    const clipped = merged.length > maxLen ? merged.slice(-maxLen) : merged;
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] メモ内容準備: mergedLength=${merged.length}, clippedLength=${clipped.length}`);
    const noteValue = clipped.trim() || null;
    if (!noteValue) {
      const msg = "noteが空のため更新をスキップします";
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] ${msg}`);
      toast("メモが空のため更新をスキップしました");
      return false;
    }
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] mutation実行: noteValueLength=${noteValue.length}`);
    const q2 = await adminGraphql(INVENTORY_TRANSFER_EDIT_NOTE_MUTATION, { id: transferId, input: { note: noteValue } });
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] mutationレスポンス受信: ${q2 ? "あり" : "なし"}`);
    if (!q2) {
      const msg = "レスポンスが空です";
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] エラー: ${msg}`);
      toast(`メモ保存エラー: ${msg}`);
      return false;
    }
    if (!q2.inventoryTransferEdit) {
      const msg = "inventoryTransferEditがレスポンスに含まれていません";
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] エラー: ${msg}`);
      toast(`メモ保存エラー: ${msg}`);
      return false;
    }
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] inventoryTransferEditあり、userErrors確認中...`);
    const errs = q2.inventoryTransferEdit.userErrors || [];
    if (errs.length) {
      const errorDetails = errs.map((e) => `${e.field || "unknown"}: ${e.message || "unknown"}`).join(" / ");
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] userErrors: ${errorDetails}`);
      toast(`メモ保存エラー: ${errorDetails}`);
      return false;
    }
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] userErrorsなし、inventoryTransfer確認中...`);
    if (!q2.inventoryTransferEdit.inventoryTransfer) {
      const msg = "レスポンスが不正です（Transferが返されませんでした）";
      if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] エラー: ${msg}`);
      toast(`メモ保存エラー: ${msg}`);
      return false;
    }
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] 成功: メモが更新されました`);
    toast("管理画面メモに記録しました");
    return true;
  } catch (e) {
    const errorMsg = String(e?.message || e);
    if (processLogCallback) processLogCallback(`[appendInventoryTransferNote_] 例外: ${errorMsg}`);
    (SHOPIFY?.toast?.show)?.(`メモ保存例外: ${errorMsg}`);
    return false;
  }
}

const VARIANT_CACHE_NS = "stock_transfer_pos_variant_cache_v1";
const VARIANT_CACHE_META_KEY = `${VARIANT_CACHE_NS}:meta`;
const VARIANT_CACHE_CHUNK_PREFIX = `${VARIANT_CACHE_NS}:chunk:`;
const VARIANT_CACHE_CHUNKS = 32;
const VARIANT_CACHE_FLUSH_MS = 2500;

function normalizeScanCode_(code) {
  const s = String(code ?? "").trim();
  if (!s) return "";
  return s.replace(/\s+/g, "").toUpperCase().replace(/[^0-9A-Z._-]/g, "");
}

function hashString_(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h) >>> 0;
}

function chunkIndexForCode_(code) {
  return hashString_(code) % VARIANT_CACHE_CHUNKS;
}

function chunkKey_(idx) {
  return `${VARIANT_CACHE_CHUNK_PREFIX}${String(idx).padStart(2, "0")}`;
}

const VariantCache = (() => {
  const chunks = new Map();
  const loadingChunkPromises = new Map();
  const dirtyChunks = new Set();
  let flushTimer = null;
  let inited = false;
  let initPromise = null;

  async function ensureStorage_() {
    return !!(SHOPIFY?.storage?.get && SHOPIFY?.storage?.set);
  }

  async function init_() {
    if (inited) return true;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!(await ensureStorage_())) {
        inited = true;
        return false;
      }
      try {
        const meta = await SHOPIFY.storage.get(VARIANT_CACHE_META_KEY);
        if (!meta || typeof meta !== "object") {
          await SHOPIFY.storage.set(VARIANT_CACHE_META_KEY, { v: 1, chunks: VARIANT_CACHE_CHUNKS, savedAt: Date.now() });
        }
      } catch (_) {}
      inited = true;
      return true;
    })();
    return initPromise;
  }

  async function loadChunk_(idx) {
    await init_();
    if (chunks.has(idx)) return chunks.get(idx);
    if (loadingChunkPromises.has(idx)) return loadingChunkPromises.get(idx);
    const p = (async () => {
      if (!(await ensureStorage_())) {
        const empty = {};
        chunks.set(idx, empty);
        return empty;
      }
      try {
        const obj = await SHOPIFY.storage.get(chunkKey_(idx));
        const map = obj && typeof obj === "object" ? obj : {};
        chunks.set(idx, map);
        return map;
      } catch {
        const empty = {};
        chunks.set(idx, empty);
        return empty;
      } finally {
        loadingChunkPromises.delete(idx);
      }
    })();
    loadingChunkPromises.set(idx, p);
    return p;
  }

  function scheduleFlush_() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush_().catch(() => {});
    }, VARIANT_CACHE_FLUSH_MS);
  }

  async function flush_() {
    if (!(await ensureStorage_())) {
      dirtyChunks.clear();
      return;
    }
    const idxs = Array.from(dirtyChunks);
    if (idxs.length === 0) return;
    for (const idx of idxs) {
      const map = chunks.get(idx) || {};
      await SHOPIFY.storage.set(chunkKey_(idx), map);
    }
    dirtyChunks.clear();
  }

  return {
    async get(codeRaw) {
      const code = normalizeScanCode_(codeRaw);
      if (!code) return null;
      const idx = chunkIndexForCode_(code);
      const map = await loadChunk_(idx);
      const v = map?.[code] ?? null;
      return v && typeof v === "object" ? v : null;
    },
    async put(codeRaw, valueObj) {
      const code = normalizeScanCode_(codeRaw);
      if (!code) return;
      const idx = chunkIndexForCode_(code);
      const map = await loadChunk_(idx);
      map[code] = {
        variantId: valueObj?.variantId ?? null,
        inventoryItemId: valueObj?.inventoryItemId ?? null,
        sku: valueObj?.sku ?? "",
        barcode: valueObj?.barcode ?? "",
        productTitle: valueObj?.productTitle ?? "",
        variantTitle: valueObj?.variantTitle ?? "",
        imageUrl: valueObj?.imageUrl ?? "",
        updatedAt: Date.now(),
      };
      chunks.set(idx, map);
      dirtyChunks.add(idx);
      scheduleFlush_();
    },
    init: init_,
  };
})();

function pickBestVariant_(codeRaw, list) {
  const code = normalizeScanCode_(codeRaw);
  if (!code) return null;
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;
  const byBarcode = arr.find((x) => normalizeScanCode_(x?.barcode) === code);
  if (byBarcode) return byBarcode;
  const bySku = arr.find((x) => normalizeScanCode_(x?.sku) === code);
  if (bySku) return bySku;
  return arr[0];
}

export async function resolveVariantByCode(codeRaw, { includeImages = false } = {}) {
  const code = normalizeScanCode_(codeRaw);
  if (!code) return null;
  const cached = await VariantCache.get(code);
  if (cached?.variantId && cached?.inventoryItemId) return cached;
  const list = await searchVariants(code, { includeImages });
  const v = pickBestVariant_(code, list);
  if (!v?.variantId || !v?.inventoryItemId) return null;
  const resolved = {
    variantId: v.variantId,
    inventoryItemId: v.inventoryItemId,
    sku: v.sku || "",
    barcode: v.barcode || "",
    productTitle: v.productTitle || "",
    variantTitle: v.variantTitle || "",
    imageUrl: v.imageUrl || "",
  };
  await VariantCache.put(code, resolved);
  if (resolved.sku) await VariantCache.put(resolved.sku, resolved);
  if (resolved.barcode) await VariantCache.put(resolved.barcode, resolved);
  return resolved;
}

export { VariantCache };
