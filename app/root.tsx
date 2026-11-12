import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { adminFontFamily } from "./components/adminUi";
import "./admin-ui.css";

export default function App() {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body
        style={{
          fontFamily: adminFontFamily,
          fontSize: 14,
          lineHeight: 1.4,
          color: "#202223",
        }}
      >
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
