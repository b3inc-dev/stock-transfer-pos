import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="入庫"
      subheading="在庫処理"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
