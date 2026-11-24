import "@shopify/ui-extensions/preact";
import { render } from "preact";
export default async () => render(<Tile />, document.body);
function Tile() {
  return <s-tile heading="取置" subheading="登録・履歴" onClick={() => shopify.action.presentModal()} />;
}
