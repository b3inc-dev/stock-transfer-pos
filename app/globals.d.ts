declare module "*.css";

// App Bridge ナビゲーション用 Web コンポーネント（location-stock-indicator と同様）
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-link": React.DetailedHTMLProps<
        React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string },
        HTMLAnchorElement
      >;
    }
  }
}
