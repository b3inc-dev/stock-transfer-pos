import { render } from "preact";
import { checkPosPlanAccess } from "../../common/posPlanGate.js";
import { pendingTileSubheading } from "../../common/pendingTileCount.js";
import { usePendingTileCount } from "../../common/usePendingTileCount.js";
import { readPendingStocktakeCount } from "./screens/stocktake/stocktakeApi.js";
async function loadCount(location) {
  const access = await checkPosPlanAccess("stocktake");
  if (access.access !== "allowed") throw new Error("利用権限を確認できません");
  return readPendingStocktakeCount(location);
}
export default async () => render(<Tile />, document.body);
function Tile() {
  const count = usePendingTileCount(loadCount);
  return <s-tile heading="棚卸" subheading={pendingTileSubheading(count, "登録・履歴")} onClick={() => shopify.action.presentModal()} />;
}
