/**
 * Contract tests for CAS stale message/code matcher + source-file invariants (R7 / rollback CAS).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Mirror of isChangeFromQuantityStaleError in inventory-set-quantities-server.ts */
function isChangeFromQuantityStaleError(errorSummary, userErrors) {
  if (Array.isArray(userErrors)) {
    for (const e of userErrors) {
      const code = String(e?.code ?? "").toUpperCase();
      if (code.includes("CHANGE_FROM_QUANTITY")) {
        return true;
      }
      const m = String(e?.message ?? "").toLowerCase();
      if (
        m.includes("changefromquantity") ||
        m.includes("change_from_quantity") ||
        m.includes("change from quantity")
      ) {
        return true;
      }
    }
  }
  if (!errorSummary) return false;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("changefromquantity") ||
    s.includes("change_from_quantity") ||
    s.includes("change from quantity")
  );
}

assert.equal(isChangeFromQuantityStaleError(undefined), false);
assert.equal(isChangeFromQuantityStaleError("network timeout"), false);
assert.equal(
  isChangeFromQuantityStaleError("The changeFromQuantity value is stale"),
  true
);
assert.equal(
  isChangeFromQuantityStaleError("change from quantity does not match"),
  true
);
assert.equal(
  isChangeFromQuantityStaleError("other", [{ code: "CHANGE_FROM_QUANTITY_STALE", message: "x" }]),
  true
);
assert.equal(
  isChangeFromQuantityStaleError("other", [{ code: "STALE", message: "x" }]),
  false
);
assert.equal(
  isChangeFromQuantityStaleError("other", [{ code: "COMPARE_QUANTITY", message: "x" }]),
  false
);
assert.equal(
  isChangeFromQuantityStaleError("other", [{ code: "NOT_STOCKED", message: "not stocked" }]),
  false
);

const src = fs.readFileSync(path.join(root, "app/utils/inventory-set-quantities-server.ts"), "utf8");
assert.match(src, /export function isChangeFromQuantityStaleError/);
assert.match(src, /userErrors \{ field message code \}/);
assert.match(src, /casFromLiveSnapshot/);
assert.match(src, /rollbackAppliedSnapshots/);
assert.match(src, /skippedConcurrent > 0[\s\S]*partiallyApplied: true/);
assert.match(
  fs.readFileSync(path.join(root, "app/routes/api.inventory.apply-change.tsx"), "utf8"),
  /isChangeFromQuantityStale\(result\)/
);

console.log("change-from-quantity-stale.test.mjs: ok");
