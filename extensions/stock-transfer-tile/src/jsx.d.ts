// src/jsx.d.ts
export {};

declare module "preact" {
  namespace JSX {
    interface IntrinsicElements {
      // s-* を全部許可（細かく型を作らず、まず赤線を消す目的）
      [elemName: string]: any;
    }
  }
}

