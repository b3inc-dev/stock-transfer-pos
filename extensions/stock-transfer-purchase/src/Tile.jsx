import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="仕入"
      subheading="処理・履歴"
      onClick={() => shopify.action.presentModal()}
    />
  );
}


