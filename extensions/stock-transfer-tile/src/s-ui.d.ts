// src/s-ui.d.ts
// s-* (POS UI extension custom elements) JSX typing

declare namespace JSX {
  interface IntrinsicElements {
    // Layout
    "s-page": any;
    "s-scroll-box": any;
    "s-box": any;
    "s-stack": any;
    "s-divider": any;

    // Text / Inputs
    "s-text": any;
    "s-text-field": any;
    "s-button": any;

    // Modal / Media
    "s-modal": any;
    "s-image": any;
  }
}
