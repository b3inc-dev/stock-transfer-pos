import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="仕入"
      subheading="在庫処理"
      onClick={() => shopify.action.presentModal()}
    />
  );
}


