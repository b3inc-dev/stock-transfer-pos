import assert from "node:assert/strict";
import { test } from "node:test";
import { japaneseCustomerName, japanesePhoneDisplay } from "../extensions/common/customerDisplay.js";
test("customer display uses family name then given name without guessing from displayName", () => {
  assert.equal(japaneseCustomerName({ firstName: "花子", lastName: "山田", displayName: "花子 山田" }), "山田 花子");
  assert.equal(japaneseCustomerName({ displayName: "登録済みの表示名" }), "登録済みの表示名");
  assert.equal(japaneseCustomerName({ lastName: "山田" }), "山田");
});
test("Japanese E164 contact is displayed nationally and other countries/masked values stay intact", () => {
  assert.equal(japanesePhoneDisplay("+81 80-1234-5678"), "080-1234-5678");
  assert.equal(japanesePhoneDisplay("+81312345678"), "03-1234-5678");
  assert.equal(japanesePhoneDisplay("09012345678"), "090-1234-5678");
  assert.equal(japanesePhoneDisplay("+1 415-555-1234"), "+1 415-555-1234");
  assert.equal(japanesePhoneDisplay("•••• 5678"), "•••• 5678");
});
