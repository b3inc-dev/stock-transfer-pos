import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="ロス"
      subheading="在庫調整"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
