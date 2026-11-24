import assert from "node:assert/strict";
import { test } from "node:test";
import { reservationIntakeLabel, reservationDisplayNumber } from "../extensions/common/reservations.js";
import { reservationReceiptNotice } from "../extensions/common/reservationReceipt.js";
test("intake labels keep unknown historic values distinct", () => {
  assert.equal(reservationIntakeLabel({ intakeMethod: "in_person" }), "店頭で受付");
  assert.equal(reservationIntakeLabel({ intakeMethod: "inquiry" }), "お問い合わせでの受付");
  assert.equal(reservationIntakeLabel({}), "受付方法未記録");
  assert.equal(reservationDisplayNumber({ number: 1, id: "uuid" }), "#R0001");
  assert.equal(reservationDisplayNumber({ number: 10000 }), "#R10000");
});
test("intake notice describes enabled copies only and never offers customer copy for inquiry", () => {
  for (const value of [null, undefined, {}, { customerCopy: false, storeCopy: false }]) assert.equal(reservationReceiptNotice(value), "");
  assert.equal(reservationReceiptNotice({ customerCopy: true }, false), "");
  assert.equal(reservationReceiptNotice({ customerCopy: true }), "お客様控えは登録後に印刷します。");
  for (const customerCopy of [false, true]) assert.equal(reservationReceiptNotice({ customerCopy, storeCopy: true }, false), "店舗控えは詳細画面から印刷できます。");
  assert.equal(reservationReceiptNotice({ customerCopy: true, storeCopy: true }), "お客様控えは登録後、店舗控えは詳細画面から印刷します。");
});
