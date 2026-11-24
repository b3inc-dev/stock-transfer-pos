import { useCallback, useEffect, useRef, useState } from "react";

export function ReceiptLayoutPreview({ html, widthPx, viewportPx, horizontalScale = 1, refreshKey }: { html: string; widthPx: number; viewportPx: number; horizontalScale?: number; refreshKey?: boolean }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(600);
  // 幅の狭い画面（iPhone など）では、用紙の幅のまま縮めて全体を見せる（右が切れないように）
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      setScale(avail > 0 && avail < widthPx + 2 ? avail / (widthPx + 2) : 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [widthPx]);
  const fit = useCallback(() => {
    // スクリプトは動かさない（sandbox に allow-scripts を付けない）。高さを読むため同じ origin だけ許す
    const doc = frame.current?.contentDocument;
    // documentElementのscrollHeightは以前のiframe高さを含み、短く戻せないためbodyを測る。
    if (doc?.body) {
      // 先頭見出しのmarginがbodyの外へ相殺される場合も末尾を欠かさない。
      const bottom = (doc.body.getBoundingClientRect?.().bottom || 0) + (doc.documentElement?.scrollTop || 0);
      setHeight(Math.max(200, doc.body.scrollHeight, bottom) + 4);
    }
  }, []);
  useEffect(() => {
    const id = window.requestAnimationFrame(fit);
    return () => window.cancelAnimationFrame(id);
  }, [viewportPx, fit, refreshKey]);
  const uniformScale = widthPx / (viewportPx * horizontalScale) * scale;
  return (
    <div ref={box} className="RL-preview-box">
      <div style={{ width: (widthPx + 2) * scale, height: height * uniformScale, margin: "0 auto", overflow: "hidden" }}>
        <div
          className="RL-preview-paper"
          style={{ width: viewportPx, transform: horizontalScale === 1 ? `scale(${uniformScale})` : `scale(${uniformScale * horizontalScale}, ${uniformScale})`, transformOrigin: "top left" }}
        >
          <iframe
            ref={frame}
            title="レシートのプレビュー"
            sandbox="allow-same-origin"
            srcDoc={html}
            onLoad={fit}
            style={{ width: viewportPx, height, border: 0, display: "block", background: "#fff" }}
          />
        </div>
      </div>
    </div>
  );
}
