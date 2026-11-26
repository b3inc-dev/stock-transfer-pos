/* global globalThis */
export function tileLocationId(value = globalThis.shopify?.session?.currentSession?.locationId) {
  const id = String(value ?? "");
  if (/^gid:\/\/shopify\/Location\/\d+$/.test(id)) return id;
  return /^\d+$/.test(id) ? `gid://shopify/Location/${id}` : null;
}
export function pendingTileSubheading(count, fallback) {
  return Number.isSafeInteger(count) && count > 0 ? `未対応 ${count}件` : fallback;
}
/** Ignore late responses after a store switch/unmount and never overlap requests for the same store. */
export function createPendingTileCounter({ getLocation, load, onCount }) {
  let stopped = false, generation = 0, location = null, active = null;
  const currentLocation = () => { try { return getLocation(); } catch { return null; } };
  function refresh() {
    if (stopped) return Promise.resolve();
    const next = currentLocation();
    if (next !== location) {
      location = next; generation++; active = null; onCount(next, null);
    }
    if (!next) return Promise.resolve();
    if (active?.location === next) return active.promise;
    const ticket = ++generation, request = { location: next, promise: null };
    active = request;
    const relevant = () => !stopped && generation === ticket && currentLocation() === next;
    request.promise = Promise.resolve().then(() => relevant() ? load(next) : null).then(count => {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("件数を確認できません");
      if (relevant()) onCount(next, count);
    }).catch(() => { if (relevant()) onCount(next, null); }).finally(() => { if (active === request) active = null; });
    return request.promise;
  }
  return { refresh, checkLocation: () => { if (currentLocation() !== location) return refresh(); }, stop: () => { stopped = true; generation++; active = null; } };
}
