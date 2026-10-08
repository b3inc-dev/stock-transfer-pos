/**
 * POS → DB SoT ドキュメント API（段階移行）。
 * docType: inventory_counts | product_groups | entries | daily_snapshots
 * Transfer/Shipment / settings_v1 は扱わない。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequest,
  posJsonResponse,
  POS_API_CORS_HEADERS,
} from "../utils/pos-session-auth.server";
import { isAppEntryType, type AppEntryType } from "../utils/metafield-db-sot";
import {
  listInventoryCountDocumentsForShop,
  upsertInventoryCountDocument,
  upsertInventoryCountsBulk,
  readInventoryCountDocumentFromDb,
} from "../utils/inventory-count-document.server";
import {
  listProductGroupsFromDb,
  replaceProductGroupsForShop,
} from "../utils/product-group-document.server";
import {
  listEntriesFromDb,
  replaceEntriesForShop,
  upsertAppEntryDocument,
  countEntriesFromDb,
} from "../utils/app-entry-document.server";
import { listDailySnapshotsFromDb } from "../utils/inventory-daily-snapshot.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: POS_API_CORS_HEADERS });
  }
  const auth = await authenticatePosRequest(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const docType = url.searchParams.get("docType") || "";
  const entryType = url.searchParams.get("entryType") || "";
  const id = url.searchParams.get("id") || "";

  try {
    if (docType === "inventory_counts") {
      if (id) {
        const one = await readInventoryCountDocumentFromDb(auth.shop, id);
        return posJsonResponse({ ok: true, source: "db", count: one }, 200);
      }
      const docs = await listInventoryCountDocumentsForShop(auth.shop);
      const counts = docs.map((d) =>
        d.payload && typeof d.payload === "object"
          ? { ...(d.payload as object), id: d.countId, status: d.status }
          : {
              id: d.countId,
              status: d.status,
              countName: d.countName,
              locationId: d.locationId,
              locationName: d.locationName,
            }
      );
      return posJsonResponse({ ok: true, source: "db", counts, empty: counts.length === 0 }, 200);
    }

    if (docType === "product_groups") {
      const groups = await listProductGroupsFromDb(auth.shop);
      return posJsonResponse({ ok: true, source: "db", groups, empty: groups.length === 0 }, 200);
    }

    if (docType === "entries") {
      if (!isAppEntryType(entryType)) {
        return posJsonResponse({ ok: false, error: "invalid entryType" }, 400);
      }
      const take = Math.min(5000, Math.max(1, Number(url.searchParams.get("take") || 5000)));
      const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));
      const total = await countEntriesFromDb(auth.shop, entryType);
      const entries = await listEntriesFromDb(auth.shop, entryType, { take, skip });
      return posJsonResponse({
        ok: true,
        source: "db",
        entryType,
        entries,
        total,
        empty: total === 0,
      }, 200);
    }

    if (docType === "daily_snapshots") {
      const snapshots = await listDailySnapshotsFromDb(auth.shop);
      return posJsonResponse({
        ok: true,
        source: "db",
        snapshots,
        empty: snapshots.length === 0,
      }, 200);
    }

    return posJsonResponse({ ok: false, error: "unknown docType" }, 400);
  } catch (e: unknown) {
    return posJsonResponse(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      500
    );
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: POS_API_CORS_HEADERS });
  }
  const auth = await authenticatePosRequest(request);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return posJsonResponse({ ok: false, error: "invalid JSON" }, 400);
  }

  const docType = String(body.docType || "");
  const op = String(body.op || body.action || "replace");

  try {
    if (docType === "inventory_counts") {
      if (op === "upsert" && body.count && typeof body.count === "object") {
        const c = body.count as {
          id?: string;
          countName?: string;
          status?: string;
          locationId?: string;
          locationName?: string;
          completedAt?: string;
        };
        const countId = String(c.id || "").trim();
        if (!countId) return posJsonResponse({ ok: false, error: "count.id required" }, 400);
        const res = await upsertInventoryCountDocument({
          shop: auth.shop,
          countId,
          countName: c.countName ?? null,
          status: String(c.status || "draft"),
          locationId: c.locationId ?? null,
          locationName: c.locationName ?? null,
          payload: c,
          completedAt: c.completedAt ?? null,
        });
        return posJsonResponse({ ok: res.ok, error: res.error, id: res.id }, res.ok ? 200 : 500);
      }
      const counts = Array.isArray(body.counts) ? body.counts : [];
      const res = await upsertInventoryCountsBulk(auth.shop, counts as Array<{ id?: string; status?: string }>);
      return posJsonResponse({ ok: res.ok, count: res.count, error: res.error }, res.ok ? 200 : 500);
    }

    if (docType === "product_groups") {
      const groups = Array.isArray(body.groups) ? body.groups : [];
      const res = await replaceProductGroupsForShop(auth.shop, groups as Array<{ id?: string; name?: string }>);
      return posJsonResponse({ ok: res.ok, count: res.count, error: res.error }, res.ok ? 200 : 500);
    }

    if (docType === "entries") {
      const entryType = String(body.entryType || "");
      if (!isAppEntryType(entryType)) {
        return posJsonResponse({ ok: false, error: "invalid entryType" }, 400);
      }
      if (op === "upsert" && body.entry && typeof body.entry === "object") {
        const res = await upsertAppEntryDocument(
          auth.shop,
          entryType as AppEntryType,
          body.entry as { id?: string }
        );
        return posJsonResponse({ ok: res.ok, error: res.error }, res.ok ? 200 : 500);
      }
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const res = await replaceEntriesForShop(auth.shop, entryType as AppEntryType, entries as Array<{ id?: string }>);
      return posJsonResponse({ ok: res.ok, count: res.count, error: res.error }, res.ok ? 200 : 500);
    }

    return posJsonResponse({ ok: false, error: "unknown docType or read-only" }, 400);
  } catch (e: unknown) {
    return posJsonResponse(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      500
    );
  }
}
