import "@shopify/ui-extensions/preact";
import { render } from "preact";
export default async () => render(<ProductAction />, document.body);
function ProductAction() {
  return <s-button onClick={() => shopify.action.presentModal()}>取置する</s-button>;
}
