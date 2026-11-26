import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { pendingTileSubheading } from "../../common/pendingTileCount.js";
import { usePendingTileCount } from "../../common/usePendingTileCount.js";
import { reservationApi } from "./api.js";
const loadCount = async location => (await reservationApi({ command: "overdueCount", locationId: location })).count;
export default async () => render(<Tile />, document.body);
function Tile() {
  const count = usePendingTileCount(loadCount);
  return <s-tile heading="取置" subheading={pendingTileSubheading(count, "登録・履歴").replace("未対応", "期限超過")} onClick={() => shopify.action.presentModal()} />;
}
