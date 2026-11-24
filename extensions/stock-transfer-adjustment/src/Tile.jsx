import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="調整"
      subheading="登録・履歴"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
