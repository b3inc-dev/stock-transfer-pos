import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { outboundRequestApi } from "./api.js";
export default async () => render(<Tile />, document.body);
function Tile() {
  const [count, setCount] = useState(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => outboundRequestApi({ command: "count" }).then(data => { if (alive) setCount(data.count); }).catch(() => { if (alive) setCount(null); });
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return <s-tile heading="出庫依頼" subheading={count > 0 ? `要対応 ${count}件` : "処理・履歴"} onClick={() => shopify.action.presentModal()} />;
}
