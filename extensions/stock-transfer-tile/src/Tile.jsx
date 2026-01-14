// extensions/stock-transfer-tile/src/Tile.jsx
import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="在庫処理"
      subheading="出庫 / 入庫 / ロス登録 / 棚卸"
      onClick={() => shopify.action.presentModal()} // companion modal を開く
    />
  );
}