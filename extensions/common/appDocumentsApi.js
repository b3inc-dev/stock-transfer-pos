/**
 * POS → /api/pos-app-documents（DB SoT）。
 * 失敗時は呼び出し側が metafield にフォールバックする。
 */
async function getSessionToken() {
  try {
    if (typeof shopify !== "undefined" && shopify.session && typeof shopify.session.getSessionToken === "function") {
      return await shopify.session.getSessionToken();
    }
  } catch {}
  return null;
}

async function requestDocuments(method, { query, body } = {}) {
  const { getAppUrl } = await import("./appUrl.js");
  const appUrl = getAppUrl();
  const url = new URL(`${appUrl}/api/pos-app-documents`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { "Content-Type": "application/json" };
  const token = await getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    const err = new Error(json?.error || `pos-app-documents ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** @returns {Promise<object[]|null>} null = DB 空または未移行（metafield フォールバック） */
export async function fetchInventoryCountsFromDb() {
  try {
    const json = await requestDocuments("GET", { query: { docType: "inventory_counts" } });
    if (json.empty) return null;
    return Array.isArray(json.counts) ? json.counts : [];
  } catch (e) {
    console.warn("[appDocumentsApi] inventory_counts read failed:", e?.message || e);
    return null;
  }
}

export async function fetchInventoryCountByIdFromDb(countId) {
  try {
    const json = await requestDocuments("GET", {
      query: { docType: "inventory_counts", id: String(countId) },
    });
    return json.count || null;
  } catch {
    return null;
  }
}

export async function saveInventoryCountsToDb(counts) {
  try {
    const json = await requestDocuments("POST", {
      body: { docType: "inventory_counts", op: "replace", counts },
    });
    return Boolean(json?.ok);
  } catch (e) {
    // 409 / version conflict は metafield フォールバックさせない（ドリフト防止）
    if (e?.status === 409 || String(e?.message || "").includes("更新されています")) {
      throw e;
    }
    console.warn("[appDocumentsApi] inventory_counts write failed:", e?.message || e);
    return false;
  }
}

export async function fetchProductGroupsFromDb() {
  try {
    const json = await requestDocuments("GET", { query: { docType: "product_groups" } });
    if (json.empty) return null;
    return Array.isArray(json.groups) ? json.groups : [];
  } catch (e) {
    console.warn("[appDocumentsApi] product_groups read failed:", e?.message || e);
    return null;
  }
}

/**
 * @param {"loss"|"adjustment"|"purchase"|"order_request"} entryType
 * @returns {Promise<object[]|null>}
 */
export async function fetchEntriesFromDb(entryType, opts = {}) {
  try {
    const json = await requestDocuments("GET", {
      query: {
        docType: "entries",
        entryType,
        take: opts.take ?? 5000,
        skip: opts.skip ?? 0,
      },
    });
    if (json.empty) return null;
    return Array.isArray(json.entries) ? json.entries : [];
  } catch (e) {
    console.warn(`[appDocumentsApi] entries ${entryType} read failed:`, e?.message || e);
    return null;
  }
}

export async function saveEntriesToDb(entryType, entries) {
  try {
    const json = await requestDocuments("POST", {
      body: { docType: "entries", entryType, op: "replace", entries },
    });
    return Boolean(json?.ok);
  } catch (e) {
    console.warn(`[appDocumentsApi] entries ${entryType} write failed:`, e?.message || e);
    return false;
  }
}
