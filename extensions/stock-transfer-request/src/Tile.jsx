import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { pendingTileSubheading } from "../../common/pendingTileCount.js";
import { usePendingTileCount } from "../../common/usePendingTileCount.js";
import { outboundRequestApi } from "./api.js";
const loadCount = async location => (await outboundRequestApi({ command: "count", originId: location })).count;
export default async () => render(<Tile />, document.body);
function Tile() {
  const count = usePendingTileCount(loadCount);
  return <s-tile heading="出庫依頼" subheading={pendingTileSubheading(count, "確認・印刷・出庫")} onClick={() => shopify.action.presentModal()} />;
}
