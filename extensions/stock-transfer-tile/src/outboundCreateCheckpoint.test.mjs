/**
 * Pure-function smoke test for outboundCreateCheckpoint (no POS host).
 * Run: node extensions/stock-transfer-tile/src/outboundCreateCheckpoint.test.mjs
 */
import {
  buildOutboundAttemptId,
  buildOutboundCreateFingerprint,
  buildAttemptNoteMarker,
  parseAttemptNoteMarker,
  mergeNoteWithAttemptMarker,
  isTimeoutLikeError,
} from "./outboundCreateCheckpoint.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const id = buildOutboundAttemptId();
assert(/^oa_/.test(id), "attempt id prefix");

const fp1 = buildOutboundCreateFingerprint({
  mode: "in_transit",
  originLocationId: "gid://shopify/Location/1",
  destinationLocationId: "gid://shopify/Location/2",
  lineItems: [
    { inventoryItemId: "gid://shopify/InventoryItem/b", quantity: 2 },
    { inventoryItemId: "gid://shopify/InventoryItem/a", quantity: 1 },
  ],
});
const fp2 = buildOutboundCreateFingerprint({
  mode: "in_transit",
  originLocationId: "gid://shopify/Location/1",
  destinationLocationId: "gid://shopify/Location/2",
  lineItems: [
    { inventoryItemId: "gid://shopify/InventoryItem/a", quantity: 1 },
    { inventoryItemId: "gid://shopify/InventoryItem/b", quantity: 2 },
  ],
});
assert(fp1 === fp2, "fingerprint order-independent");

const fp3 = buildOutboundCreateFingerprint({
  mode: "in_transit",
  originLocationId: "gid://shopify/Location/1",
  destinationLocationId: "gid://shopify/Location/2",
  lineItems: [{ inventoryItemId: "gid://shopify/InventoryItem/a", quantity: 9 }],
});
assert(fp1 !== fp3, "fingerprint changes with qty");

const marker = buildAttemptNoteMarker("oa_test", 2, 5);
assert(marker === "[pos-cp:oa_test#2/5]", "marker format");
const parsed = parseAttemptNoteMarker(`POS出庫 分割 2/5 ${marker}`);
assert(parsed?.attemptId === "oa_test" && parsed.chunkIndex === 2 && parsed.chunkTotal === 5, "parse marker");

const merged = mergeNoteWithAttemptMarker("POS出庫 分割 1/2", "oa_x", 1, 2);
assert(merged.includes("[pos-cp:oa_x#1/2]"), "merge marker");
const remarged = mergeNoteWithAttemptMarker(merged, "oa_y", 1, 2);
assert(remarged.includes("[pos-cp:oa_y#1/2]") && !remarged.includes("oa_x"), "replace marker");

assert(isTimeoutLikeError(new Error("timeout 20000ms")), "timeout detect");
assert(!isTimeoutLikeError(new Error("userErrors: bad")), "non-timeout");

console.log("outboundCreateCheckpoint.test.mjs: OK");
