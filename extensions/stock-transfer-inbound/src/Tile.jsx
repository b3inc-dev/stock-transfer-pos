import { render } from "preact";
import { checkPosPlanAccess } from "../../common/posPlanGate.js";
import { pendingTileSubheading } from "../../common/pendingTileCount.js";
import { usePendingTileCount } from "../../common/usePendingTileCount.js";
import { fetchPendingInboundCount } from "./inboundApi.js";
async function loadCount(location) {
  const access = await checkPosPlanAccess("transfer");
  if (access.access !== "allowed") throw new Error("利用権限を確認できません");
  return fetchPendingInboundCount(location);
}
export default async () => render(<Tile />, document.body);
function Tile() {
  const count = usePendingTileCount(loadCount);
  return <s-tile heading="入庫" subheading={pendingTileSubheading(count, "処理・履歴")} onClick={() => shopify.action.presentModal()} />;
}
