import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Tile.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.tile.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Modal.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/screens/LossScreen.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/screens/loss/LossConditions.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/screens/loss/LossProductList.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/screens/loss/LossHistoryList.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/screens/loss/lossApi.js' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/screens/loss/FixedFooterNavBar.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/lossHelpers.js' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}
