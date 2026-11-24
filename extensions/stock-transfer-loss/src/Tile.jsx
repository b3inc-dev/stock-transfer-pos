import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="ロス"
      subheading="登録・履歴"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
