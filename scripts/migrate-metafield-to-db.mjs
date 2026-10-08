#!/usr/bin/env node
/**
 * Metafield → DB SoT 一括移行（ショップ単位）。
 *
 * 用法:
 *   DATABASE_URL=... SHOP=example.myshopify.com node scripts/migrate-metafield-to-db.mjs
 *   DATABASE_URL=... SHOP=... TYPES=inventory_counts,product_groups,entries,daily_snapshots node ...
 *
 * Offline Session を Prisma Session から読み、Admin GraphQL で metafield を取得して DB に upsert する。
 * settings_v1 / Transfer / Shipment は対象外。
 *
 * 要: 本番/ステージングで prisma migrate deploy 済みであること。
 */
import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-01";
const NS = "stock_transfer_pos";
const prisma = new PrismaClient();

const shop = (process.env.SHOP || "").trim();
const types = (process.env.TYPES || "inventory_counts,product_groups,entries,daily_snapshots")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!shop) {
  console.error("SHOP=xxx.myshopify.com を指定してください");
  process.exit(1);
}

async function graphql(accessToken, query, variables = {}) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: query.replace(/^#graphql\s*/m, "").trim(),
      variables,
    }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(" / "));
  }
  return json.data;
}

async function readMetafield(accessToken, key, { shopMetafield = false, shopNs = "inventory_info" } = {}) {
  if (shopMetafield) {
    const data = await graphql(
      accessToken,
      `#graphql query M { shop { metafield(namespace: "${shopNs}", key: "${key}") { value } } }`
    );
    return data?.shop?.metafield?.value ?? null;
  }
  const data = await graphql(
    accessToken,
    `#graphql query M { currentAppInstallation { metafield(namespace: "${NS}", key: "${key}") { value } } }`
  );
  return data?.currentAppInstallation?.metafield?.value ?? null;
}

async function readChunkedArray(accessToken, mainKey, chunkPrefix) {
  const raw = await readMetafield(accessToken, mainKey);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (!parsed?._chunked || !parsed.totalChunks) return [];
  const all = [];
  for (let i = 0; i < parsed.totalChunks; i++) {
    const chunkRaw = await readMetafield(accessToken, `${chunkPrefix}${i}`);
    if (!chunkRaw) continue;
    try {
      const arr = JSON.parse(chunkRaw);
      if (Array.isArray(arr)) all.push(...arr);
    } catch {
      /* skip */
    }
  }
  return all;
}

async function readEntriesV2OrV1(accessToken, v1Key, metaKey, chunkPrefix) {
  const metaRaw = await readMetafield(accessToken, metaKey);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      if (meta && typeof meta.chunkCount === "number") {
        const all = [];
        for (let i = 0; i < meta.chunkCount; i++) {
          const chunkRaw = await readMetafield(accessToken, `${chunkPrefix}${i}`);
          if (!chunkRaw) continue;
          try {
            const arr = JSON.parse(chunkRaw);
            if (Array.isArray(arr)) all.push(...arr);
          } catch {
            /* skip */
          }
        }
        return all;
      }
    } catch {
      /* fall through */
    }
  }
  const v1 = await readMetafield(accessToken, v1Key);
  if (!v1) return [];
  try {
    const arr = JSON.parse(v1);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function migrateInventoryCounts(accessToken) {
  const counts = await readChunkedArray(accessToken, "inventory_counts_v1", "inventory_counts_v1_c");
  let n = 0;
  for (const c of counts) {
    const countId = String(c?.id || "").trim();
    if (!countId) continue;
    const payloadJson = JSON.stringify(c);
    const useInline = payloadJson.length <= 100_000;
    await prisma.inventoryCountDocument.upsert({
      where: { shop_countId: { shop, countId } },
      create: {
        shop,
        countId,
        countName: c.countName ?? null,
        status: String(c.status || "draft"),
        locationId: c.locationId ?? null,
        locationName: c.locationName ?? null,
        payloadJson: useInline ? payloadJson : null,
        version: 1,
        source: "metafield_mirror",
        completedAt: c.completedAt ? new Date(c.completedAt) : null,
      },
      update: {
        countName: c.countName ?? null,
        status: String(c.status || "draft"),
        locationId: c.locationId ?? null,
        locationName: c.locationName ?? null,
        payloadJson: useInline ? payloadJson : null,
        version: { increment: 1 },
        source: "metafield_mirror",
        completedAt: c.completedAt ? new Date(c.completedAt) : null,
      },
    });
    n += 1;
  }
  console.log(`[inventory_counts] upserted ${n}`);
}

async function migrateProductGroups(accessToken) {
  const raw = await readMetafield(accessToken, "product_groups_v1");
  let groups = [];
  try {
    const parsed = JSON.parse(raw || "[]");
    groups = Array.isArray(parsed) ? parsed : [];
  } catch {
    groups = [];
  }
  const keep = new Set();
  for (const g of groups) {
    const groupId = String(g?.id || "").trim();
    if (!groupId) continue;
    keep.add(groupId);
    await prisma.productGroupDocument.upsert({
      where: { shop_groupId: { shop, groupId } },
      create: {
        shop,
        groupId,
        name: g.name ?? null,
        payloadJson: JSON.stringify(g),
        version: 1,
        source: "metafield_mirror",
      },
      update: {
        name: g.name ?? null,
        payloadJson: JSON.stringify(g),
        version: { increment: 1 },
        source: "metafield_mirror",
      },
    });
  }
  console.log(`[product_groups] upserted ${keep.size}`);
}

async function migrateEntries(accessToken) {
  const specs = [
    ["loss", "loss_entries_v1", "loss_entries_v2_meta", "loss_entries_v2_"],
    ["adjustment", "adjustment_entries_v1", "adjustment_entries_v2_meta", "adjustment_entries_v2_"],
    ["purchase", "purchase_entries_v1", "purchase_entries_v2_meta", "purchase_entries_v2_"],
    ["order_request", "order_request_entries_v1", "order_request_entries_v2_meta", "order_request_entries_v2_"],
  ];
  for (const [entryType, v1, meta, prefix] of specs) {
    const entries = await readEntriesV2OrV1(accessToken, v1, meta, prefix);
    let n = 0;
    for (const e of entries) {
      const entryId = String(e?.id || "").trim();
      if (!entryId) continue;
      const name =
        e.lossName || e.adjustmentName || e.purchaseName || e.orderName || e.name || null;
      await prisma.appEntryDocument.upsert({
        where: { shop_entryType_entryId: { shop, entryType, entryId } },
        create: {
          shop,
          entryType,
          entryId,
          status: e.status != null ? String(e.status) : null,
          name: name != null ? String(name) : null,
          locationId: e.locationId != null ? String(e.locationId) : null,
          payloadJson: JSON.stringify(e),
          version: 1,
          source: "metafield_mirror",
        },
        update: {
          status: e.status != null ? String(e.status) : null,
          name: name != null ? String(name) : null,
          locationId: e.locationId != null ? String(e.locationId) : null,
          payloadJson: JSON.stringify(e),
          version: { increment: 1 },
          source: "metafield_mirror",
        },
      });
      n += 1;
    }
    console.log(`[entries:${entryType}] upserted ${n}`);
  }
}

async function migrateDailySnapshots(accessToken) {
  const raw = await readMetafield(accessToken, "daily_snapshots", {
    shopMetafield: true,
    shopNs: "inventory_info",
  });
  let snapshots = [];
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed?.version === 1 && Array.isArray(parsed.snapshots)) snapshots = parsed.snapshots;
  } catch {
    snapshots = [];
  }
  await prisma.inventoryDailySnapshotRow.deleteMany({ where: { shop } });
  let n = 0;
  for (const s of snapshots) {
    if (!s?.date || !s?.locationId) continue;
    await prisma.inventoryDailySnapshotRow.create({
      data: {
        shop,
        date: s.date,
        locationId: String(s.locationId),
        locationName: s.locationName ?? null,
        totalQuantity: Number(s.totalQuantity) || 0,
        totalRetailValue: Number(s.totalRetailValue) || 0,
        totalCompareAtPriceValue: Number(s.totalCompareAtPriceValue) || 0,
        totalCostValue: Number(s.totalCostValue) || 0,
        snapshotUpdatedAt: s.updatedAt ? new Date(s.updatedAt) : null,
      },
    });
    n += 1;
  }
  console.log(`[daily_snapshots] inserted ${n}`);
}

async function main() {
  const sessions = await prisma.session.findMany({ where: { shop } });
  const offline =
    sessions.find((s) => s.id?.startsWith("offline_") || !s.isOnline) ?? sessions[0];
  if (!offline?.accessToken) {
    console.error(`Offline session not found for ${shop}`);
    process.exit(1);
  }
  console.log(`Migrating shop=${shop} types=${types.join(",")}`);
  if (types.includes("inventory_counts")) await migrateInventoryCounts(offline.accessToken);
  if (types.includes("product_groups")) await migrateProductGroups(offline.accessToken);
  if (types.includes("entries")) await migrateEntries(offline.accessToken);
  if (types.includes("daily_snapshots")) await migrateDailySnapshots(offline.accessToken);
  console.log("done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
