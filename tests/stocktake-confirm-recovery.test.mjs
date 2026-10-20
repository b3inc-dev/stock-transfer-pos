import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmedGroupIdsForConfirm,
  planDraftClear,
  areGroupsCompletedInCount,
} from "../extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeConfirmRecovery.js";

test("single mode confirms only the current group", () => {
  assert.deepEqual(
    confirmedGroupIdsForConfirm({ isMultipleMode: false, currentGroupId: "gA", targetProductGroupIds: ["gA"], payload: null }),
    ["gA"]
  );
});

test("multi mode excludes groups not in target and groups without items", () => {
  const payload = {
    completedGroups: [
      { groupId: "gA", items: [{}] },
      { groupId: "gOld", items: [{}] },
      { groupId: "gB", items: [] },
    ],
  };
  assert.deepEqual(
    confirmedGroupIdsForConfirm({ isMultipleMode: true, targetProductGroupIds: ["gA", "gB"], payload }),
    ["gA"]
  );
});

test("multi-group count clears only the confirmed group's draft", () => {
  const plan = planDraftClear({ countProductGroupIds: ["gA", "gB", "gC"], confirmedGroupIds: ["gA"] });
  assert.equal(plan.mode, "perGroup");
  assert.deepEqual(plan.groupIds, ["gA"]);
});

test("draft clear covers both GID and numeric spellings of the confirmed group", () => {
  const plan = planDraftClear({
    countProductGroupIds: ["gid://x/Group/1", "gid://x/Group/2"],
    confirmedGroupIds: ["1"],
  });
  assert.deepEqual(plan.groupIds.sort(), ["1", "gid://x/Group/1"].sort());
});

test("single-group count keeps the count-level draft key", () => {
  assert.deepEqual(planDraftClear({ countProductGroupIds: ["gA"], confirmedGroupIds: ["gA"] }), { mode: "single", groupId: "gA" });
  assert.deepEqual(planDraftClear({ countProductGroupIds: [], confirmedGroupIds: [] }), { mode: "single", groupId: "_single" });
});

test("areGroupsCompletedInCount requires groupItems for every confirmed group", () => {
  const count = { groupItems: { "gid://x/Group/1": [{ inventoryItemId: "i" }], g2: [] } };
  assert.equal(areGroupsCompletedInCount(count, ["1"]), true);
  assert.equal(areGroupsCompletedInCount(count, ["1", "g2"]), false);
  assert.equal(areGroupsCompletedInCount(null, ["1"]), false);
  assert.equal(areGroupsCompletedInCount(count, []), false);
});
