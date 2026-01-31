import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="在庫調整"
      subheading="ロス / 棚卸"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
