/**
 * Contract tests for formatInventoryApiError helpers.
 * Keep logic mirrored with app/utils/format-inventory-api-error.ts (pure predicates).
 */
import test from "node:test";
import assert from "node:assert/strict";

function isNotStockedAtLocationError(errorSummary) {
  if (!errorSummary) return false;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("not stocked") ||
    s.includes("is not stocked at the location") ||
    (s.includes("在庫レベル") && (s.includes("ない") || s.includes("未"))) ||
    /not stocked at the location/i.test(errorSummary)
  );
}

function isNotStockedRetryableError(errorSummary) {
  if (!errorSummary) return false;
  if (/not stocked at the location/i.test(errorSummary)) return true;
  if (/is not stocked/i.test(errorSummary)) return true;
  if (/伝播待ち/.test(errorSummary)) return true;
  if (/反映を確認できません/.test(errorSummary)) return true;
  if (/ロケーション未反映/.test(errorSummary)) return true;
  return false;
}

function formatInventoryApiError(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || /^unknown(\s+error)?$/i.test(trimmed)) {
    return "在庫APIでエラーが発生しました。通信状況を確認し、画面を再読み込みしてから再度確定してください。";
  }
  if (isNotStockedAtLocationError(trimmed) || isNotStockedRetryableError(trimmed)) {
    return (
      "一部商品がこのロケーションに在庫登録されていません（有効化の反映待ちの可能性あり）。" +
      "しばらく待ってから再度確定してください。繰り返す場合は管理画面で在庫追跡を確認してください。" +
      `（詳細: ${trimmed.slice(0, 180)}）`
    );
  }
  return trimmed;
}

test("empty / Unknown error never stay as Unknown error", () => {
  assert.match(formatInventoryApiError(""), /在庫APIでエラー/);
  assert.match(formatInventoryApiError("Unknown error"), /在庫APIでエラー/);
  assert.match(formatInventoryApiError("unknown"), /在庫APIでエラー/);
  assert.doesNotMatch(formatInventoryApiError(""), /^Unknown error$/i);
});

test("not stocked messages map to actionable JP and are retryable", () => {
  const msg = "The specified inventory item is not stocked at the location.";
  assert.equal(isNotStockedAtLocationError(msg), true);
  assert.equal(isNotStockedRetryableError(msg), true);
  assert.match(formatInventoryApiError(msg), /在庫登録されていません/);
  assert.match(formatInventoryApiError(msg), /詳細:/);
});

test("loose inventory level + not is NOT retryable (B3)", () => {
  const ambiguous = "Could not update inventory level: quantity is not available";
  assert.equal(isNotStockedRetryableError(ambiguous), false);
});

test("propagation wording is retryable", () => {
  assert.equal(
    isNotStockedRetryableError(
      "在庫有効化の応答は成功しましたが、ロケーションへの反映を確認できませんでした（伝播待ち）"
    ),
    true
  );
});

test("unrelated JP messages pass through", () => {
  const jp = "確定処理中に在庫数が変更されました。画面を再読み込みしてください。";
  assert.equal(formatInventoryApiError(jp), jp);
});
