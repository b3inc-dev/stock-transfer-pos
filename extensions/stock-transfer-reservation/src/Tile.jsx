/* global globalThis */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { reservationApi } from "./api.js";
export default async () => render(<Tile />, document.body);
function Tile() {
  const [count, setCount] = useState(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => reservationApi({ command: "count" }).then(data => { if (alive) setCount(data.count); }).catch(() => { if (alive) setCount(null); });
    refresh();
    const timer = setInterval(refresh, 60000);
    globalThis.addEventListener?.("focus", refresh);
    globalThis.document?.addEventListener?.("visibilitychange", refresh);
    return () => { alive = false; clearInterval(timer); globalThis.removeEventListener?.("focus", refresh); globalThis.document?.removeEventListener?.("visibilitychange", refresh); };
  }, []);
  return <s-tile heading="取置" subheading={count === null ? "開いて確認" : `要対応 ${count}件`} onClick={() => shopify.action.presentModal()} />;
}
