/* global globalThis */
import { useEffect, useRef, useState } from "preact/hooks";
import { createPendingTileCounter, tileLocationId } from "./pendingTileCount.js";
export function usePendingTileCount(load) {
  const loader = useRef(load); loader.current = load;
  const [state, setState] = useState({ location: null, count: null });
  useEffect(() => {
    const counter = createPendingTileCounter({ getLocation: () => tileLocationId(), load: location => loader.current(location), onCount: (location, count) => setState({ location, count }) });
    const refresh = () => { void counter.refresh(); };
    refresh();
    const timer = setInterval(refresh, 60000);
    const locationTimer = setInterval(() => { void counter.checkLocation(); }, 1000);
    globalThis.addEventListener?.("focus", refresh);
    const document = globalThis.document;
    const visible = () => { if (document?.visibilityState !== "hidden") refresh(); };
    document?.addEventListener?.("visibilitychange", visible);
    return () => { counter.stop(); clearInterval(timer); clearInterval(locationTimer); globalThis.removeEventListener?.("focus", refresh); document?.removeEventListener?.("visibilitychange", visible); };
  }, []);
  return state.location === tileLocationId() ? state.count : null;
}
