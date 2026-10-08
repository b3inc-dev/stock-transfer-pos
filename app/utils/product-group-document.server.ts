/**
 * 商品グループ DB SoT（product_groups_v1 から移行）。
 * Admin が書き、POS は読取のみ（API 経由）。
 */
import db from "../db.server";

export type ProductGroupLike = {
  id?: string;
  name?: string;
  [key: string]: unknown;
};

function modelReady(): boolean {
  return Boolean(db && typeof (db as { productGroupDocument?: unknown }).productGroupDocument !== "undefined");
}

export async function replaceProductGroupsForShop(
  shop: string,
  groups: ProductGroupLike[]
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    if (!modelReady()) return { ok: false, count: 0, error: "ProductGroupDocument model not available" };
    const list = Array.isArray(groups) ? groups : [];
    const keepIds = new Set<string>();

    for (const g of list) {
      const groupId = String(g?.id ?? "").trim();
      if (!groupId) continue;
      keepIds.add(groupId);
      const payloadJson = JSON.stringify(g);
      await db.productGroupDocument.upsert({
        where: { shop_groupId: { shop, groupId } },
        create: {
          shop,
          groupId,
          name: g?.name != null ? String(g.name) : null,
          payloadJson,
          version: 1,
          source: "db",
        },
        update: {
          name: g?.name != null ? String(g.name) : null,
          payloadJson,
          version: { increment: 1 },
          source: "db",
        },
      });
    }

    const existing = await db.productGroupDocument.findMany({
      where: { shop },
      select: { groupId: true },
    });
    const toDelete = existing.map((e: { groupId: string }) => e.groupId).filter((id: string) => !keepIds.has(id));
    if (toDelete.length > 0) {
      await db.productGroupDocument.deleteMany({
        where: { shop, groupId: { in: toDelete } },
      });
    }

    return { ok: true, count: keepIds.size };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[product-group-document] replace failed:", msg);
    return { ok: false, count: 0, error: msg };
  }
}

export async function listProductGroupsFromDb(shop: string): Promise<ProductGroupLike[]> {
  try {
    if (!modelReady()) return [];
    const docs = await db.productGroupDocument.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 2000,
    });
    const out: ProductGroupLike[] = [];
    for (const doc of docs) {
      if (!doc.payloadJson) {
        out.push({ id: doc.groupId, name: doc.name ?? undefined });
        continue;
      }
      try {
        const parsed = JSON.parse(doc.payloadJson);
        if (parsed && typeof parsed === "object") {
          out.push({ ...parsed, id: doc.groupId });
        }
      } catch {
        out.push({ id: doc.groupId, name: doc.name ?? undefined });
      }
    }
    return out;
  } catch (e: unknown) {
    console.warn(
      "[product-group-document] list failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

/** DB 優先。DB が空なら metafield 配列を返す（移行前フォールバック）。 */
export async function preferProductGroupsFromDb(
  shop: string,
  metafieldGroups: ProductGroupLike[]
): Promise<ProductGroupLike[]> {
  const fromDb = await listProductGroupsFromDb(shop);
  if (fromDb.length > 0) return fromDb;
  return Array.isArray(metafieldGroups) ? metafieldGroups : [];
}
