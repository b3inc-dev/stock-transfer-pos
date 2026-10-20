/**
 * 棚卸 1 件ずつ保存（db_v2）の結合確認。実 PostgreSQL + メモリ上の偽メタフィールドで、
 * legacy → dual → 移し替え → 照合 → db → 書き写し → 旧 POS の書き込み取り込み → 戻し を通す。
 *
 * 本番 DB には絶対に向けないこと（STOCKTAKE_VERIFY_SHOP のデータを削除する）。
 *   DATABASE_URL=postgresql://...localhost.../test \
 *   SHOPIFY_API_KEY=x SHOPIFY_API_SECRET=x SHOPIFY_APP_URL=https://example.com SCOPES=read_products \
 *   npx vite-node scripts/verify-stocktake-count-store.db.ts
 */
import assert from "node:assert/strict";
import db from "../app/db.server";
import {
  readInventoryCountsChunked,
  writeInventoryCountsChunked,
  getInventoryCountsVersion,
  type InventoryCount,
} from "../app/routes/app.inventory-count";
import {
  applyCompleteInDb,
  backfillFromLegacy,
  clearPendingCompleteDb,
  createDbCount,
  getDbCount,
  getEffectiveStorageMode,
  listDbCountsFull,
  listDbCountsMinimal,
  readLegacyNextNumber,
  readPendingCompleteDb,
  runMirrorSync,
  saveDbCounts,
  setModeOverride,
  startDbCount,
  switchMode,
  verifyAgainstLegacy,
  writePendingCompleteDb,
} from "../app/utils/stocktake-count-store.server";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error("DATABASE_URL must point to a local test database");
}

const SHOP = process.env.STOCKTAKE_VERIFY_SHOP ?? "verify-stocktake.myshopify.com";
const OWNER = "gid://shopify/AppInstallation/1";

function createFakeAdmin() {
  const store = new Map<string, string>();
  let calls = 0;
  const pattern = /(?:(\w+)\s*:\s*)?metafield\(namespace:\s*"([^"]+)",\s*key:\s*(?:"([^"]+)"|\$(\w+))\)/g;
  const graphql = async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls += 1;
    const vars = opts?.variables ?? {};
    if (/metafieldsSet\s*\(/.test(query)) {
      const mfs = (vars.metafields as Array<{ namespace: string; key: string; value: string }>) ?? [];
      for (const m of mfs) store.set(`${m.namespace}/${m.key}`, String(m.value));
      return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [] } } }));
    }
    if (/currentAppInstallation/.test(query)) {
      const inst: Record<string, unknown> = { id: OWNER };
      for (const m of query.matchAll(pattern)) {
        const alias = m[1] ?? "metafield";
        const key = m[3] ?? String(vars[m[4]] ?? "");
        const v = store.get(`${m[2]}/${key}`);
        inst[alias] = v == null ? null : { value: v };
      }
      return new Response(JSON.stringify({ data: { currentAppInstallation: inst } }));
    }
    throw new Error(`fake admin: unsupported query ${query.slice(0, 80)}`);
  };
  return { admin: { graphql }, store, calls: () => calls };
}

const group = (id: string, actual: number) => [
  { inventoryItemId: `gid://shopify/InventoryItem/${id}`, currentQuantity: 5, actualQuantity: actual },
];

function seedCounts(): InventoryCount[] {
  const base = {
    locationId: "gid://shopify/Location/1",
    locationName: "本店",
    productGroupIds: ["g1", "g2"],
    productGroupNames: ["A", "B"],
  };
  return [
    { ...base, id: "ic-1", countName: "#C0001", status: "completed", createdAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T05:00:00.000Z", groupItems: { g1: group("1", 4), g2: group("2", 5) } },
    { ...base, id: "ic-2", countName: "#C0002", status: "in_progress", createdAt: "2026-10-02T00:00:00.000Z", groupItems: { g1: group("3", 1) } },
    { ...base, id: "ic-3", countName: "#C0003", status: "draft", createdAt: "2026-10-03T00:00:00.000Z" },
  ] as unknown as InventoryCount[];
}

async function legacyWrite(admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> }, counts: InventoryCount[]) {
  const v = await getInventoryCountsVersion(admin as never);
  const r = await writeInventoryCountsChunked(admin as never, counts, OWNER, v);
  assert.deepEqual(r.userErrors, [], "legacy write failed");
}

async function reset() {
  await db.inventoryCountGroupResult.deleteMany({ where: { shop: SHOP } });
  await db.inventoryCountDocumentChunk.deleteMany({ where: { document: { shop: SHOP } } });
  await db.inventoryCountDocument.deleteMany({ where: { shop: SHOP } });
  await db.stocktakePendingComplete.deleteMany({ where: { shop: SHOP } });
  await db.stocktakeStorageState.deleteMany({ where: { shop: SHOP } });
}

async function step(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

async function main() {
  await reset();
  const { admin, store } = createFakeAdmin();
  const a = admin as never;

  await step("legacy seed is readable through the existing chunked reader", async () => {
    await legacyWrite(admin, seedCounts());
    const legacy = await readInventoryCountsChunked(a);
    assert.equal(legacy.length, 3);
    assert.equal(await getEffectiveStorageMode(SHOP), "legacy");
  });

  await step("db override before backfill is downgraded to dual", async () => {
    await setModeOverride(SHOP, "db");
    assert.equal(await getEffectiveStorageMode(SHOP), "dual");
    await setModeOverride(SHOP, "dual");
  });

  await step("backfill copies every count into per-count rows and verify matches", async () => {
    const bf = await backfillFromLegacy(SHOP, a);
    assert.equal(bf.ok, true);
    assert.equal(bf.inserted, 3);
    const again = await backfillFromLegacy(SHOP, a);
    assert.equal(again.unchanged, 3, "backfill must be idempotent");
    const v = await verifyAgainstLegacy(SHOP, a);
    assert.deepEqual([v.onlyInDb, v.onlyInLegacy, v.different, v.same], [[], [], [], 3]);
    const groups = await db.inventoryCountGroupResult.count({ where: { shop: SHOP } });
    assert.equal(groups, 3);
  });

  await step("switch to db mode", async () => {
    const r = await switchMode(SHOP, a, OWNER, "db");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await getEffectiveStorageMode(SHOP), "db");
  });

  await step("create assigns the next number under a shop lock (parallel creates do not collide)", async () => {
    const legacyNext = await readLegacyNextNumber(a);
    const mk = (id: string) =>
      createDbCount(SHOP, { id, status: "draft", createdAt: new Date().toISOString(), locationId: "gid://shopify/Location/1", productGroupIds: ["g1"] }, legacyNext);
    const [r4, r5] = await Promise.all([mk("ic-4"), mk("ic-5")]);
    assert.equal(r4.ok && r5.ok, true);
    const names = [r4, r5].map((r) => (r.ok ? r.countName : "")).sort();
    assert.deepEqual(names, ["#C0004", "#C0005"]);
  });

  await step("start moves draft to in_progress once", async () => {
    const c = await startDbCount(SHOP, "ic-3");
    assert.equal(c?.status, "in_progress");
    const again = await startDbCount(SHOP, "ic-3");
    assert.equal(again?.status, "in_progress");
    assert.equal((await getDbCount(SHOP, "ic-3"))?.version, 2);
  });

  await step("parallel completes of two groups both survive (row lock) and finish the count", async () => {
    const [r1, r2] = await Promise.all([
      applyCompleteInDb(SHOP, "ic-3", [{ groupId: "g1", items: group("7", 2) }]),
      applyCompleteInDb(SHOP, "ic-3", [{ groupId: "g2", items: group("8", 3) }]),
    ]);
    assert.equal(r1.ok && r2.ok, true);
    const rec = await getDbCount(SHOP, "ic-3");
    assert.deepEqual(Object.keys(rec?.count.groupItems ?? {}).sort(), ["g1", "g2"]);
    assert.equal(rec?.count.status, "completed");
    assert.ok(rec?.count.completedAt);
  });

  await step("completing an unknown count reports notFound", async () => {
    const r = await applyCompleteInDb(SHOP, "nope", [{ groupId: "g1", items: [] }]);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.notFound, true);
  });

  await step("stale writer gets a version conflict", async () => {
    const rec = await getDbCount(SHOP, "ic-2");
    const ok = await saveDbCounts(SHOP, [{ ...rec!.count, countName: "#C0002" }], new Map([["ic-2", rec!.version]]));
    assert.equal(ok.ok, true);
    const stale = await saveDbCounts(SHOP, [{ ...rec!.count, status: "cancelled" }], new Map([["ic-2", rec!.version]]));
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.conflict, true);
  });

  await step("mirror writes DB content to the metafield for old POS builds", async () => {
    const r = await runMirrorSync(SHOP, a, OWNER);
    assert.equal(r.ok, true, r.error);
    const v = await verifyAgainstLegacy(SHOP, a);
    assert.deepEqual([v.onlyInDb, v.onlyInLegacy, v.different], [[], [], []]);
    assert.equal(v.same, 5);
    assert.equal(store.get("stock_transfer_pos/inventory_count_next_v1"), "6");
    const state = await db.stocktakeStorageState.findUnique({ where: { shop: SHOP } });
    assert.equal(state?.mirrorDirty, false);
  });

  await step("old POS writes to the metafield are ingested conservatively", async () => {
    const legacy = (await readInventoryCountsChunked(a)) as unknown as Array<Record<string, unknown>>;
    const edited = legacy.map((c) => {
      if (c.id === "ic-4") return { ...c, status: "in_progress" };
      if (c.id === "ic-1") return { ...c, status: "in_progress", groupItems: { g1: group("1", 999) } };
      return c;
    });
    await legacyWrite(admin, edited as unknown as InventoryCount[]);
    const r = await runMirrorSync(SHOP, a, OWNER);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.ingested, 1);
    assert.equal((await getDbCount(SHOP, "ic-4"))?.count.status, "in_progress");
    const ic1 = (await getDbCount(SHOP, "ic-1"))?.count;
    assert.equal(ic1?.status, "completed", "completed must not be downgraded");
    assert.equal((ic1?.groupItems?.g1 as Array<{ actualQuantity: number }>)[0].actualQuantity, 4);
    const back = (await readInventoryCountsChunked(a)) as unknown as Array<Record<string, unknown>>;
    assert.equal(back.find((c) => c.id === "ic-1")?.status, "completed", "mirror restores DB truth");
  });

  await step("list is newest first and has no group results", async () => {
    const list = await listDbCountsMinimal(SHOP);
    assert.equal(list.length, 5);
    assert.equal("groupItems" in list[list.length - 1], false);
    assert.equal(list[list.length - 1].id, "ic-1");
  });

  await step("per-count pending backup write/read/clear", async () => {
    assert.equal(await writePendingCompleteDb(SHOP, { countId: "ic-2", completedGroups: [{ groupId: "g2", items: group("9", 1) }], savedAt: new Date().toISOString() }), true);
    assert.equal(await writePendingCompleteDb(SHOP, { countId: "ic-4", completedGroups: [], savedAt: new Date().toISOString() }), true);
    assert.equal((await readPendingCompleteDb(SHOP, "gid://app/InventoryCount/ic-2"))?.countId, "ic-2");
    await clearPendingCompleteDb(SHOP, "ic-2");
    assert.equal(await readPendingCompleteDb(SHOP, "ic-2"), null);
    assert.equal((await readPendingCompleteDb(SHOP))?.countId, "ic-4");
  });

  await step("rollback to legacy writes DB content back first", async () => {
    await applyCompleteInDb(SHOP, "ic-2", [{ groupId: "g2", items: group("9", 1) }]);
    const r = await switchMode(SHOP, a, OWNER, "legacy");
    assert.equal(r.ok, true, r.error);
    assert.equal(await getEffectiveStorageMode(SHOP), "legacy");
    const legacy = (await readInventoryCountsChunked(a)) as unknown as Array<Record<string, unknown>>;
    assert.equal(legacy.length, 5);
    assert.equal(legacy.find((c) => c.id === "ic-2")?.status, "completed");
    const dbAll = await listDbCountsFull(SHOP);
    assert.equal(dbAll.length, 5, "DB rows are kept for a later retry");
  });

  await reset();
  console.log("all steps passed");
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
