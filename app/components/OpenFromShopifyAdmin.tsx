// アプリの URL を Shopify 管理画面の外で開いたときの案内。
// 店のドメインの入力欄は置かない（App Store 要件 2.3.1）。
import type { CSSProperties } from "react";

const wrap: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  textAlign: "center",
};

export function OpenFromShopifyAdmin() {
  return (
    <main style={wrap}>
      <div style={{ display: "grid", gap: "1rem", maxWidth: "32rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>POS Stock</h1>
        <p style={{ margin: 0 }}>
          Open this app from your Shopify admin: <strong>Apps</strong> &rarr; <strong>POS Stock</strong>.
        </p>
        <p style={{ margin: 0 }}>このアプリは Shopify 管理画面の「アプリ」から開いてください。</p>
        <p style={{ margin: 0 }}>
          <a href="https://admin.shopify.com/">Go to Shopify admin</a>
        </p>
      </div>
    </main>
  );
}
