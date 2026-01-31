import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

// 設定画面のloader、action、コンポーネントをそのまま使用
// これにより、/app にアクセスしたときに設定画面のコンテンツが直接表示される
export { loader, action, default } from "./app.settings";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
