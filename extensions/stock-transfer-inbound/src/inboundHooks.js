import { useState, useEffect, useMemo } from "preact/hooks";
import { setStateSlice, adminGraphql, toUserMessage } from "./inboundHelpers.js";

const SHOPIFY = globalThis?.shopify;

export function useSessionLocationId() {
  const [rawId, setRawId] = useState(() => SHOPIFY?.session?.currentSession?.locationId ?? null);
  useEffect(() => {
    let alive = true;
    let tickCount = 0;
    const tick = () => {
      if (!alive) return;
      const next = SHOPIFY?.session?.currentSession?.locationId ?? null;
      setRawId((prev) => {
        const p = prev == null ? "" : String(prev);
        const n = next == null ? "" : String(next);
        return p === n ? prev : next;
      });
      tickCount += 1;
      if (next) return;
      if (tickCount >= 50) clearInterval(iv);
    };
    const iv = setInterval(tick, 100);
    tick();
    return () => { alive = false; clearInterval(iv); };
  }, []);
  return rawId;
}

export function useOriginLocationGid() {
  const raw = useSessionLocationId();
  return useMemo(() => {
    if (!raw) return null;
    const s = String(raw);
    if (s.startsWith("gid://shopify/Location/")) return s;
    if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
    const m = s.match(/Location\/(\d+)/);
    if (m?.[1]) return `gid://shopify/Location/${m[1]}`;
    return null;
  }, [raw]);
}

/** Stable empties — inline `[]` / `{}` each render breaks callers that treat list identity as a dep. */
const EMPTY_LOCATION_LIST = Object.freeze([]);
const EMPTY_LOCATION_BY_ID = Object.freeze({});

export function useLocationsIndex(appState, setAppState) {
  const cacheRaw = appState?.locations_cache_v1;
  const cache = cacheRaw && typeof cacheRaw === "object" ? cacheRaw : null;
  const loaded = !!cache?.loaded;
  const loading = !!cache?.loading;
  useEffect(() => {
    let mounted = true;
    async function load() {
      if (loaded || loading) return;
      // Keep list/byId keys present so callers never fall back to a fresh [] each render.
      setStateSlice(setAppState, "locations_cache_v1", (prev) => ({
        list: Array.isArray(prev?.list) ? prev.list : [],
        byId: prev?.byId && typeof prev.byId === "object" ? prev.byId : {},
        loaded: false,
        ...prev,
        loading: true,
        error: "",
      }));
      try {
        const data = await adminGraphql(
          `#graphql
          query Locs($first: Int!) {
            locations(first: $first) { nodes { id name } }
          }`,
          { first: 250 }
        );
        const list = Array.isArray(data?.locations?.nodes) ? data.locations.nodes : [];
        const byId = {};
        for (const l of list) byId[l.id] = l.name;
        if (!mounted) return;
        setStateSlice(setAppState, "locations_cache_v1", { loaded: true, loading: false, error: "", list, byId });
      } catch (e) {
        if (!mounted) return;
        setStateSlice(setAppState, "locations_cache_v1", (prev) => ({
          list: Array.isArray(prev?.list) ? prev.list : [],
          byId: prev?.byId && typeof prev.byId === "object" ? prev.byId : {},
          ...prev,
          loaded: false,
          loading: false,
          error: toUserMessage(e),
        }));
      }
    }
    load();
    return () => { mounted = false; };
  }, [loaded, loading, setAppState]);
  return {
    loaded,
    loading,
    error: String(cache?.error || ""),
    list: Array.isArray(cache?.list) ? cache.list : EMPTY_LOCATION_LIST,
    byId: cache?.byId && typeof cache.byId === "object" ? cache.byId : EMPTY_LOCATION_BY_ID,
  };
}

export function getLocationName_(locationId, locationsById) {
  const id = String(locationId || "").trim();
  if (!id) return "（不明）";
  const name = locationsById?.[id];
  return name ? String(name) : "（不明）";
}

export function useDebounce(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
