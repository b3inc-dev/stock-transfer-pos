// Shop Point（b3inc-dev/shop-point）の staging の app/components/admin-ui.tsx（e36f9b04）の写し。UI ルール v1.1 の 13章。
// 見た目は画面ごとに書かず、この部品を使う。直すときは Shop Point と同じに保つ。
import { Form, Link, useNavigate } from "react-router";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { SaveBar as AppSaveBar, useAppBridge } from "@shopify/app-bridge-react";

/** POS Stock のナビ、白カード、主操作、補足、保存エラーに合わせた共通見た目。 */
export const adminCss = `
  .Admin-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
    padding: 12px 16px;
    margin-bottom: 16px;
    background: #f6f6f7;
    border-bottom: 1px solid #e1e3e5;
    font-size: 14px;
    line-height: 1.4;
    position: relative;
    z-index: 100;
    min-height: 44px;
    box-sizing: border-box;
  }
  .Admin-nav a {
    color: #303030;
    font-weight: 500;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 40px;
    padding: 0 12px;
    border-radius: 8px;
  }
  .Admin-nav a:hover { background: #ebebeb; }
  /* 今のページは灰色の角丸の背景で示す（VIP の画面と同じ見え方、11/20 T） */
  .Admin-nav a.is-active { background: #e3e3e3; color: #1a1a1a; font-weight: 600; }
  .Admin-nav a:focus-visible,
  .Admin-primary:focus-visible,
  .Admin-secondary:focus-visible,
  .Admin-critical:focus-visible,
  .Admin-tertiary:focus-visible,
  .Admin-input:focus-visible,
  .Admin-select:focus-visible {
    outline: 2px solid #2c6ecb;
    outline-offset: 2px;
  }
  .Admin-body { padding: 16px; max-width: 1200px; box-sizing: border-box; }
  .Admin-back { padding: 12px 16px 0; max-width: 1200px; box-sizing: border-box; }
  .Admin-back + .Admin-body { padding-top: 8px; }
  .Admin-back-button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; color: #303030; background: transparent; text-decoration: none; }
  .Admin-back-button:hover, .Admin-back-button:active, .Admin-back-button:focus-visible { background: #e3e3e3; }
  .Admin-back-button:focus-visible { outline: 2px solid #005bd3; outline-offset: 1px; }
  .Admin-section-tabs { position: relative; display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; border-bottom: 1px solid #e1e3e5; margin-bottom: 16px; }
  .Admin-section-tabs::-webkit-scrollbar { display: none; }
  .Admin-section-tabs button { flex: 0 0 auto; white-space: nowrap; border: 0; border-bottom: 3px solid transparent; padding: 8px 12px; min-height: 44px; background: transparent; color: #202223; font: inherit; cursor: pointer; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; }
  .Admin-section-tabs button::after { content: attr(data-label); font-weight: 600; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; }
  .Admin-section-tabs button[aria-pressed=true] { border-bottom-color: #2c6ecb; font-weight: 600; }
  .Admin-edit-body { padding-bottom: 16px; }
  .Admin-save-bar { position: fixed; inset: auto 0 0; z-index: 101; display: flex; justify-content: flex-end; align-items: center; gap: 12px; background: #fff; border-top: 1px solid #e1e3e5; padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px)); }
  /* 保存結果を保存ボタンと同じ行の左に出す（11/19 T）。文言が無いときも空の要素でボタンを右に寄せる */
  .Admin-save-status { margin-right: auto; font-size: 13px; line-height: 1.4; color: #202223; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .Admin-save-status[data-tone=success] { color: #007f5f; font-weight: 600; }
  .Admin-save-status[data-tone=warning] { color: #8a6116; font-weight: 600; }
  .Admin-save-status[data-tone=critical] { color: #d72c0d; font-weight: 600; display: block; -webkit-line-clamp: unset; overflow: visible; }
  .Admin-plan-card { margin-bottom: 16px; }
  .Admin-member-section { margin-bottom: 16px; }
  .Admin-member-search { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 16px; }
  .Admin-member-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px 24px; margin: 12px 0 0; }
  .Admin-member-grid dt { font-size: 13px; font-weight: 600; color: #6d7175; margin-bottom: 4px; }
  .Admin-member-grid dd { margin: 0; font-size: 13px; color: #202223; overflow-wrap: anywhere; }
  .Admin-member-adjust { border-top: 1px solid #e1e3e5; margin-top: 16px; padding-top: 12px; }
  .Admin-member-adjust-row { display: flex; flex-wrap: wrap; gap: 12px; }
  .Admin-member-adjust-row .Admin-field { flex: 1 1 160px; }
  .Admin-member-table { min-width: 720px; }
  .Admin-home { display: flex; gap: 0 24px; flex-wrap: wrap; }
  .Admin-home-side { flex: 0 1 320px; min-width: 260px; }
  .Admin-home-main { flex: 1 1 60%; min-width: 280px; }
  .Admin-home-card, .Admin-card {
    background: #fff;
    box-sizing: border-box;
  }
  .Admin-home-card {
    margin-bottom: 16px;
    padding: 16px;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .Admin-card {
    border-radius: 12px;
    box-shadow: 0 0 0 1px #e1e3e5;
    padding: 16px;
  }
  .Admin-kicker { margin-bottom: 8px; font-size: 14px; font-weight: 600; color: #6d7175; line-height: 1.4; }
  .Admin-title { font-size: 14px; font-weight: 600; color: #202223; margin-bottom: 4px; line-height: 1.4; }
  .Admin-note { font-size: 13px; color: #6d7175; line-height: 1.4; overflow-wrap: anywhere; }
  .Admin-figure { font-size: 18px; font-weight: 700; color: #202223; font-variant-numeric: tabular-nums; }
  .Admin-setting {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .Admin-setting-copy { flex: 1 1 260px; min-width: 0; }
  .Admin-setting-card { flex: 1 1 320px; min-width: min(100%, 280px); }
  .Admin-control { margin-bottom: 12px; }
  /* 欄と欄の間に置いた説明は、次の欄の見出しとくっつかないよう下に余白をとる */
  .Admin-setting-card s-text { display: block; margin: 0 0 16px; }
  .Admin-control:last-child { margin-bottom: 0; }
  .Admin-actions { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 16px; }
  .Admin-primary, .Admin-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 4px 12px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    line-height: 1.4;
    text-decoration: none;
    box-sizing: border-box;
    cursor: pointer;
  }
  /* ボタンの色は Shopify の管理画面と同じ。主ボタンは黒で1画面に1つ、赤は取り消せない操作だけ（11/20 T） */
  .Admin-primary { background: #303030; color: #fff; border: none; box-shadow: inset 0 -1px 0 #000; }
  .Admin-primary:hover { background: #1a1a1a; }
  .Admin-secondary { background: #fff; color: #303030; border: 1px solid #e3e3e3; box-shadow: inset 0 -1px 0 #d4d4d4; }
  .Admin-critical { background: #c70a24; color: #fff; border: none; }
  .Admin-critical:hover { background: #a3071c; }
  .Admin-tertiary { background: transparent; color: #303030; border: 1px solid transparent; }
  .Admin-tertiary:hover { background: #ebebeb; }
  .Admin-critical, .Admin-tertiary {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 28px; padding: 4px 12px;
    border-radius: 8px; font-size: 12px; font-weight: 600; font-family: inherit; line-height: 1.4; text-decoration: none; box-sizing: border-box; cursor: pointer;
  }
  .Admin-primary, .Admin-secondary { gap: 6px; border-radius: 8px; }
  .Admin-primary:disabled, .Admin-secondary:disabled, .Admin-critical:disabled { opacity: 0.5; cursor: not-allowed; }
  .Admin-icon-button { min-width: 28px; padding: 4px; }
  .Admin-row-actions { display: inline-flex; flex-wrap: nowrap; gap: 8px; align-items: center; }
  .Admin-row-actions form { margin: 0; }
  .Admin-menu-list { display: flex; flex-direction: column; min-width: 160px; padding: 4px; }
  .Admin-menu-list button { justify-content: flex-start; width: 100%; margin: 0; }
  .Admin-banner { margin-bottom: 16px; }
  .Admin-pick { border: 1px solid #e1e3e5; border-radius: 8px; padding: 6px; max-height: 240px; overflow-y: auto; background: #fff; }
  .Admin-pick-search { margin: 0 0 8px; }
  .Admin-pick-row { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 12px; margin: 0 0 4px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; font-weight: 500; }
  .Admin-pick-row:last-child { margin-bottom: 0; }
  .Admin-pick-row:hover { background: #f7f7f7; }
  .Admin-pick-row[data-selected=true] { background: #eff6ff; border-color: #2563eb; font-weight: 600; }
  .Admin-pick-row input { width: 16px; height: 16px; margin: 0; flex-shrink: 0; }
  .Admin-pick-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .Admin-pick-count { font-size: 13px; color: #616161; margin: 4px 0 0; }
  .Admin-card-head { margin: 0 0 12px; }
  .Admin-copy-action { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
  /* VIP と同じ「アイコン・見出し・1行の要約・編集」の行（11/20 T） */
  .Admin-sum-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid #ebebeb; }
  .Admin-sum-row:first-child { border-top: 0; padding-top: 0; }
  .Admin-sum-row:last-child { padding-bottom: 0; }
  .Admin-sum-icon { flex: 0 0 32px; height: 32px; border: 1px solid #e3e3e3; border-radius: 8px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
  .Admin-sum-body { flex: 1 1 auto; min-width: 0; }
  .Admin-sum-title { font-weight: 600; font-size: 13px; color: #303030; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  /* 表の形で入力する一覧（ランク表など。11/20 T）。PC は1行1件で見比べられる表、スマホは1件1枚のカード（横スクロールさせない） */
  .Admin-ehead, .Admin-erow { display: grid; grid-template-columns: var(--cols); gap: 8px 12px; align-items: center; }
  .Admin-ehead { font-size: 12px; color: #616161; font-weight: 500; padding: 0 0 6px; }
  .Admin-erow { padding: 8px 0; border-top: 1px solid #ebebeb; }
  .Admin-erow[data-deleted=true] { opacity: 0.55; }
  .Admin-ecell { min-width: 0; }
  .Admin-ecell-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .Admin-ecell-end { justify-self: end; }
  .Admin-form .Admin-erow label { margin: 0; }
  .Admin-form .Admin-ecell input:not([type=checkbox]):not([type=radio]), .Admin-form .Admin-ecell select { margin-top: 0; }
  .Admin-unit { position: relative; display: flex; align-items: center; }
  .Admin-form .Admin-unit input:not([type=checkbox]):not([type=radio]) { padding-right: 52px; margin-top: 0; }
  .Admin-unit-text { position: absolute; right: 10px; color: #8a8a8a; font-size: 12px; pointer-events: none; white-space: nowrap; }
  .Admin-sum-text { font-size: 13px; color: #616161; margin-top: 2px; overflow-wrap: anywhere; }
  .Admin-link-list { padding: 0; overflow: hidden; }
  .Admin-link-row { display: flex; align-items: center; gap: 12px; padding: 14px 16px; color: #303030; border-top: 1px solid #ebebeb; min-height: 56px; box-sizing: border-box; }
  .Admin-link-row:first-child { border-top: 0; }
  .Admin-link-row:hover { background: #f7f7f7; }
  .Admin-link-row:focus-visible { outline: 2px solid #2c6ecb; outline-offset: -2px; }
  .Admin-link-body { flex: 1 1 auto; min-width: 0; }
  .Admin-link-title { font-weight: 600; font-size: 14px; color: #303030; }
  .Admin-link-text { font-size: 13px; color: #616161; margin-top: 2px; overflow-wrap: anywhere; }
  .Admin-body a.Admin-link-row { color: #303030; }
  .Admin-empty { text-align: center; padding: 24px 8px; }
  .Admin-empty-title { font-size: 16px; font-weight: 650; color: #303030; margin: 8px 0 4px; }
  .Admin-empty p { margin: 0 0 16px; color: #616161; font-size: 13px; }
  .Admin-confirm-text { margin: 0 0 12px; font-size: 13px; line-height: 1.5; }
  .Admin-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .Admin-button-sm { white-space: nowrap; }
  .Admin-secondary:hover { background: #f6f6f7; }
  /* リンクには下線を付けない（11/20 T） */
  .Admin-body a, .Admin-nav a { text-decoration: none; }
  .Admin-body a:not(.Admin-primary):not(.Admin-secondary) { color: #2c6ecb; }
  .Admin-text-link { font-size: 13px; color: #2c6ecb; text-decoration: none; font-weight: 500; }
  .Admin-text-link:focus-visible { outline: 2px solid #2c6ecb; outline-offset: 2px; }
  .Admin-status {
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 13px;
    color: #202223;
    line-height: 1.4;
    margin-bottom: 16px;
  }
  .Admin-status strong { font-weight: 600; }
  .Admin-status-warning { background: #fff4e5; border: 1px solid #e0b252; }
  .Admin-status-critical { background: #fff4f4; border: 1px solid #d72c0d; }
  .Admin-status-success { background: #f1f8f5; border: 1px solid #008060; }
  .Admin-filters {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    margin-top: 12px;
  }
  .Admin-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .Admin-field-label { font-size: 13px; font-weight: 600; color: #202223; }
  .Admin-input, .Admin-select {
    width: 100%;
    box-sizing: border-box;
    font-size: 13px;
    font-family: inherit;
    color: #202223;
    background: #fff;
    border: 1px solid #8a8a8a;
    border-radius: 8px;
    padding: 4px 12px;
    min-height: 32px;
  }
  .History-scroll { overflow-x: auto; }
  .History-scroll table:not(.History-table) th, .History-scroll table:not(.History-table) td { white-space: nowrap; }
  .History-memo { display: block; white-space: normal; overflow-wrap: anywhere; color: #6d7175; font-size: 13px; margin-top: 2px; }
  /* 幅は中身で決める（固定の最小幅はカードより広くなり右端が切れたため外した）。入りきらないときは History-scroll で横スクロール */
  .History-table { width: 100%; border-collapse: collapse; }
  .History-keep { white-space: nowrap; }
  .History-text { min-width: 8em; }
  .History-table th {
    font-size: 13px;
    font-weight: 600;
    color: #6d7175;
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #e1e3e5;
    white-space: nowrap;
  }
  .History-table td {
    font-size: 13px;
    color: #202223;
    padding: 10px 12px;
    border-bottom: 1px solid #f1f2f3;
    vertical-align: top;
  }
  .History-num { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  .History-table th.History-num { text-align: right; white-space: normal; min-width: 4em; }
  .History-id { white-space: nowrap; }
  .History-clip { display: inline-block; max-width: 10em; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
  .Admin-delta-plus { color: #008060; font-weight: 600; }
  .Admin-delta-minus { color: #d72c0d; font-weight: 600; }
  .Admin-delta-zero { color: #6d7175; }
  .Admin-loading {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    padding: 12px 16px;
    background: #2563eb;
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    text-align: center;
    z-index: 9999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  /* AdminBlock のカード内: 素の入力・説明・表を POS Stock の白カードの見た目にそろえる */
  .Admin-stack { flex-direction: column; gap: 12px; }
  .Admin-stack .Admin-setting-copy, .Admin-stack .Admin-setting-card { flex: 1 1 auto; width: 100%; min-width: 0; }
  .Admin-intro { margin: 0 0 16px; }
  .Admin-intro p { margin: 0 0 8px; font-size: 13px; color: #6d7175; line-height: 1.5; }
  .Admin-form { font-size: 13px; color: #202223; line-height: 1.5; overflow-wrap: anywhere; }
  .Admin-form p, .Admin-form ul, .Admin-form details { margin: 0 0 12px; }
  .Admin-form ul { padding-left: 20px; }
  .Admin-form h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; }
  .Admin-form label { display: block; margin: 0 0 12px; font-weight: 500; }
  .Admin-form p label { margin-bottom: 0; }
  .Admin-form fieldset label:has(input[type=checkbox], input[type=radio]) { display: inline-flex; align-items: center; gap: 6px; margin: 0 16px 8px 0; min-height: 32px; }
  .Admin-form label:has(input[type=checkbox]):not(fieldset label) { display: flex; align-items: flex-start; gap: 8px; font-weight: 400; }
  .Admin-form input[type=checkbox], .Admin-form input[type=radio] { width: 16px; height: 16px; margin: 2px 0 0; flex-shrink: 0; }
  .Admin-form input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]),
  .Admin-form select, .Admin-form textarea {
    display: block; width: 100%; box-sizing: border-box; margin-top: 4px;
    font-size: 13px; font-family: inherit; font-weight: 400; color: #202223; background: #fff;
    border: 1px solid #8a8a8a; border-radius: 8px; padding: 4px 12px; min-height: 32px;
  }
  .Admin-form input:is([type=date], [type=datetime-local], [type=time]), .Admin-input:is([type=date], [type=datetime-local]) {
    -webkit-appearance: none; appearance: none; min-width: 0; max-width: 100%; text-align: left;
  }
  .Admin-form input::-webkit-date-and-time-value, .Admin-input::-webkit-date-and-time-value { text-align: left; }
  .Admin-form input[type=file] { display: block; margin-top: 4px; font: inherit; }
  .Admin-form :is(input, select, textarea):focus-visible { outline: 2px solid #2c6ecb; outline-offset: 2px; }
  .Admin-form fieldset { border: 1px solid #e1e3e5; border-radius: 8px; padding: 12px; margin: 0 0 12px; min-width: 0; }
  .Admin-form :is(p, ul, details, label, fieldset, table, form, div):last-child { margin-bottom: 0; }
  .Admin-form legend { font-weight: 600; padding: 0 4px; }
  .Admin-form button:not([class]) {
    display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 4px 12px; margin: 0 8px 8px 0;
    border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600; background: #fff; color: #303030; border: 1px solid #e3e3e3; box-shadow: inset 0 -1px 0 #d4d4d4; cursor: pointer;
  }
  .Admin-form button:disabled { opacity: 0.5; cursor: not-allowed; }
  .Admin-form button:not([class]):focus-visible { outline: 2px solid #2c6ecb; outline-offset: 2px; }
  .Admin-form .Admin-secondary, .Admin-form .Admin-primary { margin: 0 8px 8px 0; }
  .Admin-form table:not(.History-table) { width: 100%; border-collapse: collapse; margin: 0 0 12px; }
  .Admin-form table:not(.History-table) :is(th, td) { padding: 8px 12px; border-bottom: 1px solid #f1f2f3; text-align: left; vertical-align: top; }
  .Admin-form table:not(.History-table) th { color: #6d7175; font-weight: 600; }
  .Admin-form tbody th { width: 40%; }
  .Admin-form code { font-size: 13px; background: #f6f6f7; border-radius: 4px; padding: 0 4px; overflow-wrap: anywhere; }
  .Admin-form article { border-top: 1px solid #e1e3e5; padding-top: 12px; margin-top: 12px; }
  .Admin-form a { color: #2c6ecb; }
  .Admin-body p[role=status], .Admin-body [role=alert]:not(.Admin-status) {
    padding: 10px 12px; border-radius: 6px; font-size: 13px; color: #202223; line-height: 1.4; margin: 0 0 12px;
    background: #f1f8f5; border: 1px solid #008060;
  }
  .Admin-body [role=alert]:not(.Admin-status) { background: #fff4f4; border-color: #d72c0d; list-style-position: inside; }
  .Admin-body span[role=alert] { display: block; margin-top: 4px; }
  /* レポート（11/20 T「エクセルみたいでチープ」→ 作り直し）。数字のタイル・線と上下の棒・内訳の細い横棒 */
  .Report-toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; }
  /* 開始日・終了日・会員ID は同じ幅にそろえる（11/20 T） */
  .Report-toolbar .Admin-field { flex: 0 0 168px; width: 168px; margin: 0; }
  .Report-toolbar .Admin-input { width: 100%; box-sizing: border-box; }
  .Report-toolbar-end { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .Report-presets { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 10px; font-size: 13px; }
  .Report-presets a { color: #303030; text-decoration: none; padding: 2px 8px; border-radius: 6px; }
  .Report-presets a:hover { background: #f1f1f1; }
  .Report-presets a[aria-current=true] { background: #ebebeb; font-weight: 600; }
  .Report-meta { font-size: 12px; color: #616161; margin: 10px 2px 12px; }
  .Report-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
  .Report-kpi { background: #fff; border-radius: 12px; box-shadow: 0 0 0 1px #e1e3e5; padding: 14px 16px; min-width: 0; }
  .Report-kpi-label { font-size: 13px; color: #616161; }
  .Report-kpi-value { font-size: 22px; font-weight: 650; color: #303030; margin-top: 4px; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; white-space: nowrap; }
  .Report-kpi-value small { font-size: 13px; font-weight: 500; color: #616161; margin-left: 4px; }
  .Report-kpi-sub { font-size: 12px; color: #616161; margin-top: 4px; }
  .Report-card { margin-bottom: 12px; }
  .Report-card-head { display: flex; gap: 8px 16px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 8px; }
  .Report-card-head .Admin-title { margin: 0; }
  .Report-card-head .Admin-note { margin: 2px 0 0; }
  .Report-card-head-end { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .Report-seg { display: inline-flex; border-radius: 8px; box-shadow: 0 0 0 1px #e3e3e3; overflow: hidden; }
  .Report-seg a { padding: 4px 12px; font-size: 12px; color: #303030; text-decoration: none; min-width: 20px; text-align: center; }
  .Report-seg a + a { box-shadow: inset 1px 0 0 #e3e3e3; }
  .Report-seg a[aria-current=true] { background: #303030; color: #fff; font-weight: 600; }
  .Admin-body .Report-presets a:not(.Admin-primary):not(.Admin-secondary), .Admin-body .Report-seg a:not(.Admin-primary):not(.Admin-secondary), .Admin-body a.Member-row:not(.Admin-primary):not(.Admin-secondary) { color: #303030; }
  .Admin-body .Report-seg a[aria-current=true]:not(.Admin-primary):not(.Admin-secondary) { color: #fff; }
  .Report-chart { position: relative; width: 100%; }
  .Report-chart svg rect[tabindex]:focus { outline: none; }
  .Report-chart svg rect[tabindex]:focus-visible { outline: 2px solid #2c6ecb; }
  .Report-tooltip { position: absolute; pointer-events: none; z-index: 2; background: #fff; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06); padding: 8px 12px; font-size: 12px; color: #303030; line-height: 1.6; white-space: nowrap; }
  .Report-tooltip-head { font-weight: 600; margin-bottom: 2px; }
  .Report-tooltip-sub { color: #616161; }
  .Report-key { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: 1px; }
  .Report-legend { display: flex; gap: 16px; font-size: 12px; color: #616161; }
  .Report-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
  .Report-two .Admin-card { margin: 0; }
  .Report-break { width: 100%; border-collapse: collapse; font-size: 13px; color: #303030; }
  .Report-break td { padding: 9px 4px; border-top: 1px solid #f1f1f1; vertical-align: middle; }
  .Report-break tr:first-child td { border-top: none; }
  .Report-break .is-total td { border-top: 1px solid #e3e3e3; font-weight: 600; }
  .Report-break-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .Report-break-bar { width: 38%; padding-left: 12px; }
  .Report-break-pct { width: 3.5em; text-align: right; color: #616161; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .Report-share { display: block; height: 6px; border-radius: 3px; background: #f1f1f1; overflow: hidden; }
  .Report-share span { display: block; height: 100%; border-radius: 3px; min-width: 2px; }
  .Report-plus { color: #303030; font-weight: 600; }
  .Report-minus { color: #616161; font-weight: 600; }
  .Report-history-filter { display: flex; gap: 8px; align-items: center; }
  .Report-history-filter .Admin-select { min-height: 28px; font-size: 12px; padding: 2px 8px; }
  .Report-about { margin-top: 4px; font-size: 12px; color: #616161; }
  .Report-about summary { cursor: pointer; color: #303030; font-size: 13px; padding: 4px 0; }
  .Report-about ul { margin: 6px 0 0; padding-left: 18px; line-height: 1.6; }
  /* 会員一覧（VIP 風の行。11/20 T） */
  .Member-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  .Member-search { flex: 1 1 260px; position: relative; display: flex; }
  .Member-search .Admin-input { width: 100%; padding-left: 32px; }
  .Member-search s-icon { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); pointer-events: none; }
  .Member-tools .Admin-select { flex: 0 1 200px; }
  .Member-count { font-size: 12px; color: #616161; margin: 8px 2px 4px; }
  .Member-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid #ebebeb; }
  .Member-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) minmax(90px, 160px) 110px 110px 16px; gap: 12px; align-items: center; padding: 10px 8px; border-bottom: 1px solid #f1f1f1; color: inherit; text-decoration: none; border-radius: 8px; }
  .Member-row:hover { background: #f7f7f7; }
  .Member-row:focus-visible { outline: 2px solid #2c6ecb; outline-offset: -2px; }
  .Member-avatar { width: 32px; height: 32px; border-radius: 50%; background: #f1f1f1; color: #616161; display: grid; place-items: center; font-size: 13px; font-weight: 600; }
  .Member-name { font-size: 13px; font-weight: 600; color: #303030; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .Member-email { font-size: 12px; color: #616161; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .Member-num { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; color: #303030; white-space: nowrap; }
  .Member-num small { display: block; font-size: 11px; color: #616161; }
  .Member-pager { display: flex; justify-content: center; gap: 8px; margin-top: 12px; }
  @media (max-width: 767px) {
    /* スマホは押しやすさのため、ボタンは高さ 40px・入力欄は 44px にする（並べ方は PC と同じ） */
    .Admin-primary, .Admin-secondary, .Admin-critical, .Admin-tertiary, .Admin-form button:not([class]) { min-height: 40px; padding: 8px 14px; font-size: 14px; }
    .Admin-icon-button { min-width: 40px; }
    .Admin-ehead { display: none; }
    .Admin-erow { grid-template-columns: 1fr 1fr; padding: 12px 0; }
    .Admin-ecell-label { position: static; width: auto; height: auto; clip: auto; display: block; font-size: 12px; color: #616161; margin-bottom: 4px; white-space: normal; }
    .Admin-ecell-wide { grid-column: 1 / -1; }
    .Admin-ecell-end { justify-self: start; }
    .Admin-input, .Admin-select, .Admin-form input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), .Admin-form select, .Admin-form textarea { min-height: 44px; font-size: 16px; }
    /* スマホではメニューを 1 行の横スライドにする（VIP と同じ。11/20 T） */
    .Admin-nav { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: 8px 12px; }
    .Admin-nav::-webkit-scrollbar { display: none; }
    .Admin-nav a { flex: 0 0 auto; white-space: nowrap; }
    .Admin-home { flex-direction: column; }
    .Admin-home-side, .Admin-home-main { order: 2; flex: 1 1 100%; min-width: 0; width: 100%; }
    .Admin-home-side { order: 1; }
    /* 縦積みでは flex-basis が高さになり、タイトルとカードの間が 260px 空く（11/19 T のスマホ表示）。高さは中身に合わせる */
    .Admin-setting { flex-direction: column; gap: 8px; }
    .Admin-setting-copy, .Admin-setting-card { flex: 0 0 auto; width: 100%; min-width: 0; }
    .History-table { min-width: 0; }
    .History-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .History-table, .History-table tbody, .History-table tr, .History-table td { display: block; width: auto; }
    .History-table tr {
      margin: 0 0 12px;
      padding: 8px 0;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .History-table td {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      border-bottom: none;
      text-align: right;
    }
    .History-table td::before {
      content: attr(data-label);
      color: #6d7175;
      font-weight: 600;
      text-align: left;
      flex: 0 0 42%;
    }
    .History-num { text-align: right; }
    .History-table td { overflow-wrap: anywhere; }
    .History-table td.History-keep, .History-table td.History-id { white-space: normal; min-width: 0; }
    .History-clip { max-width: none; white-space: normal; overflow-wrap: anywhere; }
    /* ポイントレポートの履歴は 1 件を 2〜3 行に詰める（T 11/21「SP の行間が大きく見づらい」）。
       1 行目: 日時、2 行目: 会員（右に 1〜2 行目にまたがってポイント）、3 行目: 種別・注文（あるときだけ） */
    .History-table[data-report=history] tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 10px 12px; margin: 0 0 8px; }
    .History-table[data-report=history] td { display: block; padding: 0; text-align: left; }
    .History-table[data-report=history] td::before { content: none; }
    .History-table[data-report=history] td:nth-child(1) { grid-area: 1 / 1; color: #6d7175; font-size: 12px; }
    .History-table[data-report=history] td:nth-child(4) { grid-area: 1 / 2 / 3 / 3; align-self: center; text-align: right; font-weight: 600; }
    .History-table[data-report=history] td:nth-child(2) { grid-area: 2 / 1; }
    .History-table[data-report=history] td:nth-child(3) { grid-area: 3 / 1; color: #6d7175; font-size: 12px; }
    .History-table[data-report=history] td:nth-child(5) { grid-area: 3 / 2; text-align: right; color: #6d7175; font-size: 12px; }
    .History-table[data-report=history] td:nth-child(5)[data-empty=true] { display: none; }
    /* 履歴の会員一覧も 2 行に詰める（T 11/21）。1 行目: 会員ID・利用可能、2 行目: 付与予定（あるときだけ）・取引を比較 */
    .History-table[data-report=accounts] tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 10px 12px; margin: 0 0 8px; }
    .History-table[data-report=accounts] td { display: block; padding: 0; text-align: left; }
    .History-table[data-report=accounts] td::before { content: none; }
    .History-table[data-report=accounts] td:nth-child(1) { grid-area: 1 / 1; }
    .History-table[data-report=accounts] td:nth-child(2) { grid-area: 1 / 2; text-align: right; font-weight: 600; }
    .History-table[data-report=accounts] td:nth-child(3) { grid-area: 2 / 1; color: #6d7175; font-size: 12px; }
    .History-table[data-report=accounts] td:nth-child(3)::before { content: attr(data-label); margin-right: 6px; }
    .History-table[data-report=accounts] td:nth-child(3)[data-empty=true] { visibility: hidden; }
    .History-table[data-report=accounts] td:nth-child(4) { grid-area: 2 / 2; text-align: right; }
    /* 取引の履歴（履歴の照会・会員詳細）も同じく詰める（T 11/21）。
       1 行目: 日時・状態、2 行目: 内容・増減、3 行目: 注文・残高、4 行目: チャネル（付与予定が動いた行は右に付与予定） */
    .History-table[data-report=ledger] tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 10px 12px; margin: 0 0 8px; }
    .History-table[data-report=ledger] td { display: block; padding: 0; text-align: left; }
    .History-table[data-report=ledger] td::before { content: none; }
    .History-table[data-report=ledger] td:nth-child(9) { grid-area: 1 / 1; color: #6d7175; font-size: 12px; }
    .History-table[data-report=ledger] td:nth-child(1) { grid-area: 1 / 2; text-align: right; }
    .History-table[data-report=ledger] td:nth-child(6) { grid-area: 2 / 1; }
    .History-table[data-report=ledger] td:nth-child(2) { grid-area: 2 / 2; text-align: right; font-weight: 600; }
    .History-table[data-report=ledger] td:nth-child(7) { grid-area: 3 / 1; color: #6d7175; font-size: 12px; }
    .History-table[data-report=ledger] td:nth-child(8) { grid-area: 4 / 1; color: #6d7175; font-size: 12px; }
    .History-table[data-report=ledger] td:nth-child(3) { grid-area: 3 / 2; text-align: right; color: #6d7175; font-size: 12px; }
    .History-table[data-report=ledger] td:nth-child(4) { grid-area: 4 / 2; text-align: right; font-size: 12px; }
    .History-table[data-report=ledger] td:nth-child(5) { grid-area: 5 / 2; text-align: right; color: #6d7175; font-size: 12px; }
    .History-table[data-report=ledger] td:is(:nth-child(3), :nth-child(4), :nth-child(5))::before { content: attr(data-label); margin-right: 6px; }
    .History-table[data-report=ledger] td[data-empty=true] { display: none; }
    .Report-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .Report-kpi-value { font-size: 18px; }
    .Report-two { grid-template-columns: 1fr; }
    .Report-break-bar { width: 22%; padding-left: 8px; }
    .Report-break td { padding: 9px 2px; }
    .Report-toolbar .Admin-field { flex: 1 1 calc(50% - 6px); width: auto; min-width: 0; }
    .Report-toolbar-end { margin-left: 0; }
    .Report-seg a { padding: 8px 14px; font-size: 14px; }
    .Member-row { grid-template-columns: 36px minmax(0, 1fr) auto 16px; grid-template-areas: none; row-gap: 4px; }
    .Member-tools .Admin-select { flex: 1 1 40%; min-width: 0; }
    .Member-avatar { grid-column: 1; grid-row: 1 / 3; }
    .Member-who { grid-column: 2; grid-row: 1; }
    .Member-rank { grid-column: 2; grid-row: 2; }
    .Member-num { grid-column: 3; grid-row: 1; }
    .Member-num-pending { grid-row: 2; }
    .Member-chevron { grid-column: 4; grid-row: 1 / 3; }
  }
  @media (min-width: 768px) {
    .Admin-home-main { order: 1; }
    .Admin-home-side { order: 2; }
    /* 列幅の定義（11/20 T）。768px 未満はすべて1列 */
    /* 形1 設定: 左の説明 1 : 右のカード 2（説明は 240px 以上、カードは 320px 以上） */
    .Admin-setting:not(.Admin-stack) { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(320px, 2fr); gap: 24px; }
    .Admin-setting:not(.Admin-stack) .Admin-setting-copy, .Admin-setting:not(.Admin-stack) .Admin-setting-card { min-width: 0; }
    /* 形2 詳細・ホーム: 左の主な内容は残り全部、右の要約は 280〜360px */
    .Admin-home { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); gap: 0 24px; align-items: start; }
    .Admin-home-main, .Admin-home-side { min-width: 0; }
    .Admin-filters { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; }
  }
`;

/**
 * ページ内のタブ。どの幅でも1行の横スライドにし、選んだタブが見える位置まで送る（11/19 T）。
 * 選ぶと太字になるが、太字の幅を ::after で先に取っておくので、隣の項目はずれない。
 */
export function SectionTabs({ label, items, selected, onSelect, disabled = false }: {
  label: string;
  items: { key: string; label: string; controls?: string }[];
  selected: string;
  onSelect: (key: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const nav = ref.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const active = nav.querySelector<HTMLElement>("button[aria-pressed=true]");
    if (!active) return;
    const left = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [selected]);
  return (
    <nav className="Admin-section-tabs" aria-label={label} ref={ref}>
      {items.map((item) => (
        <button key={item.key} type="button" disabled={disabled} aria-controls={item.controls} data-label={item.label}
          aria-pressed={selected === item.key} onClick={() => onSelect(item.key)}>{item.label}</button>
      ))}
    </nav>
  );
}

export function AdminSections({ label, sections, busy }: {
  label: string;
  busy: boolean;
  sections: { title: string; content: ReactNode }[];
}) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  return (
    <div className="Admin-body">
      <SectionTabs label={label} disabled={busy} selected={String(selected)} onSelect={(key) => setSelected(Number(key))}
        items={sections.map(({ title }, index) => ({ key: String(index), label: title, controls: `${id}-${index}` }))} />
      {sections.map(({ title, content }, index) => (
        <section key={title} id={`${id}-${index}`} aria-label={title} hidden={selected !== index}>
          {content}
        </section>
      ))}
    </div>
  );
}

/**
 * カードの形は画面の役割で使い分ける（11/20 T）。
 * 1. 入力して保存する設定: 左にタイトル＋説明、右に白カード（この AdminBlock の既定）
 * 2. 1件を見る詳細・ホーム: カード2列（左に主な内容、右に要約）。Admin-home / Admin-home-main / Admin-home-side
 * 3. 並べて見る一覧・表・レポート・入口: カード1列で、見出しと説明はカードの中（AdminBlock wide、LinkRows）
 * スマホではどれも1列に縦に積む。
 */
export function AdminBlock({ title, description, children, wide = false, id, hidden, action }: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  id?: string;
  hidden?: boolean;
  /** 追加などのボタン。どの形でも説明のすぐ下に置く（VIP と同じ。11/20 T） */
  action?: ReactNode;
}) {
  if (wide) {
    // 表・一覧など幅が要るもの（定義3: カード1列、見出しと説明はカードの中。11/20 T）
    return (
      <section className="Admin-setting Admin-stack" id={id} hidden={hidden}>
        <div className="Admin-setting-card">
          <div className="Admin-card Admin-form">
            <div className="Admin-card-head">
              <div className="Admin-title">{title}</div>
              {description ? <div className="Admin-note">{description}</div> : null}
              {action ? <div className="Admin-copy-action">{action}</div> : null}
            </div>
            {children}
          </div>
        </div>
      </section>
    );
  }
  // 入力して保存する設定（定義1: 左にタイトル＋説明、右にカード）
  return (
    <section className="Admin-setting" id={id} hidden={hidden}>
      <div className="Admin-setting-copy">
        <div className="Admin-title">{title}</div>
        {description ? <div className="Admin-note">{description}</div> : null}
        {action ? <div className="Admin-copy-action">{action}</div> : null}
      </div>
      <div className="Admin-setting-card">
        <div className="Admin-card Admin-form">{children}</div>
      </div>
    </section>
  );
}

/** 本文の上に置く画面全体の説明（白カードの外、補足の色）。 */
export function AdminIntro({ children }: { children: ReactNode }) {
  return <div className="Admin-intro">{children}</div>;
}

/** 画面の下端の戻り先などのリンク列。 */
export function AdminFooterLinks({ children }: { children: ReactNode }) {
  return <div className="Admin-actions">{children}</div>;
}

export function AdminStyle() {
  return <style>{adminCss}</style>;
}

export type AdminEntitlement = {
  channel: string;
  heading: string;
  body: string;
  upgradePrompt: boolean;
  usagePrompt: boolean;
  upgradeLabel: string | null;
  usageLabel: string | null;
  feeYen: number | null;
};

export function EntitlementNotice({
  entitlement,
  reason,
  showPlan = false,
}: {
  entitlement: AdminEntitlement | null;
  reason?: string | null;
  /** 配布・プランの案内（対応が要らない表示）を出すか。ホームの横の列だけで出し、ほかの画面では警告だけ出す（11/19 T） */
  showPlan?: boolean;
}) {
  // showPlan はホームの横の列の案内カードだけを描く。警告（権限・プラン・利用枠）は上の通常の呼び出しが描く（二重に出さない）
  if (showPlan) {
    if (reason === "staff_permission" || !entitlement || entitlement.upgradePrompt || entitlement.usagePrompt) return null;
    return <PlanCard entitlement={entitlement} />;
  }
  if (reason === "staff_permission") {
    return (
      <StatusBanner tone="critical" heading="権限がありません">
        <span data-blocked-reason="staff_permission">
          この店舗のポイント画面を開く権限がありません。設定の保存と履歴の照会は表示しません。
        </span>
      </StatusBanner>
    );
  }
  if (!entitlement) return null;
  if (entitlement.upgradePrompt) {
    return (
      <StatusBanner tone="warning" heading={entitlement.upgradeLabel ?? "プラン"}>
        <span data-upgrade-prompt="true" data-distribution={entitlement.channel}>
          {entitlement.body}
        </span>
      </StatusBanner>
    );
  }
  if (entitlement.usagePrompt) {
    return (
      <StatusBanner tone="warning" heading={entitlement.usageLabel ?? "利用枠"}>
        <span data-usage-prompt="true" data-distribution={entitlement.channel}>
          {entitlement.body}
        </span>
      </StatusBanner>
    );
  }
  return null;
}

function PlanCard({ entitlement }: { entitlement: AdminEntitlement }) {
  return (
    <section
      className="Admin-home-card Admin-plan-card"
      data-entitlement={entitlement.channel}
      data-upgrade-prompt="false"
      data-fee-yen={entitlement.feeYen == null ? "" : String(entitlement.feeYen)}
    >
      <div className="Admin-kicker">{entitlement.heading}</div>
      <p className="Admin-note">{entitlement.body}</p>
    </section>
  );
}

/** 画面やカードの上に出すお知らせ枠（Shopify の s-banner）。見出しは「何が起きたか」、中身は「どうすればいいか」。 */
export function StatusBanner({
  tone,
  heading,
  children,
  dismissible = false,
}: {
  tone: "warning" | "critical" | "success" | "info";
  heading: string;
  children?: ReactNode;
  dismissible?: boolean;
}) {
  return (
    <div className="Admin-banner" data-tone={tone}>
      <s-banner tone={tone} heading={heading} dismissible={dismissible || undefined}>
        {children}
      </s-banner>
    </div>
  );
}

const BADGE_TONES: Record<string, "success" | "info" | "neutral" | "warning" | "critical" | "caution"> = {
  適用中: "success",
  有効: "success",
  完了: "success",
  付与済み: "success",
  開始前: "info",
  受付: "info",
  処理中: "info",
  実行中: "info",
  停止中: "neutral",
  終了: "neutral",
  無効: "neutral",
  下書き: "neutral",
  未設定: "warning",
  要確認: "warning",
  一部失敗: "warning",
  失敗: "critical",
  エラー: "critical",
};

/** 状態はバッジで出す。色は意味で決める（緑=有効・完了、青=これから・処理中、灰=停止・終了、黄=要確認、赤=失敗）。 */
export function StateBadge({ label, tone }: { label: string; tone?: "success" | "info" | "neutral" | "warning" | "critical" | "caution" }) {
  return <s-badge tone={tone ?? BADGE_TONES[label] ?? "neutral"}>{label}</s-badge>;
}

/** まだ何もない一覧に出す表示。見出し＋1文＋最初の操作のボタン。 */
export function EmptyState({ heading, children, action }: { heading: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="Admin-empty" data-empty-state="true">
      <s-icon type="note" color="subdued" />
      <div className="Admin-empty-title">{heading}</div>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/**
 * 取り消せない操作（削除など）の赤いボタン。押すと確認の窓を開き、窓の中の赤いボタンで送信する。
 * fields は送信する hidden の値。サーバー側の確認（confirmed=yes など）もここで渡す。
 */
export function ConfirmAction({
  label,
  heading,
  message,
  confirmLabel,
  fields,
  disabled = false,
  trigger = "critical",
}: {
  label: string;
  heading: string;
  message: ReactNode;
  confirmLabel?: string;
  fields: Record<string, string>;
  disabled?: boolean;
  /** icon: 一覧・表の行の削除。ゴミ箱マークだけのボタン（文字なし、読み上げとツールチップは label） */
  trigger?: "critical" | "secondary" | "menu" | "icon";
}) {
  const id = "confirm-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hide = () => {
    const modal = document.getElementById(id) as (HTMLElement & { hideOverlay?: () => void }) | null;
    modal?.hideOverlay?.();
  };
  return (
    <>
      {trigger === "icon"
        ? <s-button commandFor={id} command="--show" disabled={disabled || undefined} variant="tertiary" icon="delete"
            accessibilityLabel={label} interestFor={id + "-tip"} />
        : <s-button commandFor={id} command="--show" disabled={disabled || undefined}
            variant={trigger === "menu" ? "tertiary" : "secondary"} tone={trigger === "secondary" ? "auto" : "critical"}>
            {label}
          </s-button>}
      {trigger === "icon" ? <s-tooltip id={id + "-tip"}>{label}</s-tooltip> : null}
      <s-modal id={id} heading={heading}>
        <Form method="post" onSubmit={hide}>
          {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <p className="Admin-confirm-text">{message}</p>
          <div className="Admin-confirm-actions">
            <button type="button" className="Admin-secondary" onClick={hide}>キャンセル</button>
            <button type="submit" className="Admin-critical" disabled={disabled}>{confirmLabel ?? label}</button>
          </div>
        </Form>
      </s-modal>
    </>
  );
}

/**
 * 一覧・表の行の削除（保存のときに反映するもの）。ゴミ箱マークだけ（11/20 T、Built for Shopify: 行の操作はアイコンのボタン）。
 * 文字は出さず、読み上げとツールチップに label を使う。
 */
export function DeleteIconButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  const id = "del-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <>
      <s-button variant="tertiary" icon="delete" accessibilityLabel={label} interestFor={id} onClick={onClick} disabled={disabled || undefined} />
      <s-tooltip id={id}>{label}</s-tooltip>
    </>
  );
}

/** 表の行を上下へ動かすアイコンのボタン（会員ランクの並べ替え。T 11/21） */
export function MoveIconButton({ label, direction, onClick, disabled = false }: { label: string; direction: "up" | "down"; onClick: () => void; disabled?: boolean }) {
  const id = "move-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <>
      <s-button variant="tertiary" icon={direction === "up" ? "arrow-up" : "arrow-down"} accessibilityLabel={label} interestFor={id} onClick={onClick} disabled={disabled || undefined} />
      <s-tooltip id={id}>{label}</s-tooltip>
    </>
  );
}

/** 表の行で3つ目以降の操作をまとめる「…」ボタン。中身は ConfirmAction trigger="menu" やボタン。 */
export function MoreActions({ label = "その他の操作", children }: { label?: string; children: ReactNode }) {
  const id = "more-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <>
      <s-button commandFor={id} command="--toggle" icon="menu-horizontal" accessibilityLabel={label} />
      <s-popover id={id}>
        <div className="Admin-menu-list">{children}</div>
      </s-popover>
    </>
  );
}

/**
 * VIP と同じ要約の行（11/20 T）。左にアイコンの枠、見出しと1行の要約、右端に「編集」。
 * アイコンは全部の行に付けるか、全部付けないか（Built for Shopify 4.1.1）。
 */
export function SummaryRows({ rows }: { rows: { key: string; title: ReactNode; text: ReactNode; icon?: string; to?: string; actionLabel?: string; action?: ReactNode }[] }) {
  const withIcons = rows.every((row) => row.icon);
  return (
    <div data-summary-rows="true">
      {rows.map((row) => (
        <div key={row.key} className="Admin-sum-row">
          {withIcons ? <span className="Admin-sum-icon"><s-icon type={row.icon as "settings"} /></span> : null}
          <div className="Admin-sum-body">
            <div className="Admin-sum-title">{row.title}</div>
            <div className="Admin-sum-text">{row.text}</div>
          </div>
          {row.action ?? (row.to ? <SecondaryLink small to={row.to}>{row.actionLabel ?? "編集"}</SecondaryLink> : null)}
        </div>
      ))}
    </div>
  );
}

/**
 * 表の形で入力する一覧（ランク表・誕生月の定額など。11/20 T）。columns の width は CSS の grid の幅（例 minmax(120px, 1.4fr)）。
 * 行は EditRow、欄は EditCell。スマホでは見出しを隠し、欄ごとに見出しを付けたカードになる。
 */
export function EditTable({ columns, children }: { columns: { label: ReactNode; width: string }[]; children: ReactNode }) {
  return (
    <div className="Admin-etable" style={{ ["--cols" as string]: columns.map((column) => column.width).join(" ") }}>
      <div className="Admin-ehead" aria-hidden="true">{columns.map((column, index) => <span key={index}>{column.label}</span>)}</div>
      {children}
    </div>
  );
}

export function EditRow({ children, deleted = false }: { children: ReactNode; deleted?: boolean }) {
  return <div className="Admin-erow" data-deleted={deleted || undefined}>{children}</div>;
}

export function EditCell({ label, children, wide = false, end = false }: { label: string; children: ReactNode; wide?: boolean; end?: boolean }) {
  return (
    <div className={"Admin-ecell" + (wide ? " Admin-ecell-wide" : "") + (end ? " Admin-ecell-end" : "")}>
      {label ? <span className="Admin-ecell-label">{label}</span> : null}
      {children}
    </div>
  );
}

/** 単位を欄の中の右に出す入力（VIP と同じ「円以上」「倍」「日」）。ラベルは読み上げ用に aria-label へ。 */
export function UnitInput({ label, unit, ...input }: { label: string; unit: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="Admin-unit">
      <input aria-label={label} {...input} />
      <span className="Admin-unit-text" aria-hidden="true">{unit}</span>
    </span>
  );
}

/** 下の画面への入口を1枚のカードに行で並べる（Shopify の「設定」の一覧と同じ）。行全体を押せ、右端に「›」。 */
export function LinkRows({ rows }: { rows: { to: string; title: string; text?: string; icon?: string; badge?: ReactNode }[] }) {
  return (
    <div className="Admin-card Admin-link-list">
      {rows.map((row) => (
        <GuardedLink key={row.to} to={row.to} className="Admin-link-row">
          {row.icon ? <s-icon type={row.icon as "import"} /> : null}
          <span className="Admin-link-body">
            <span className="Admin-link-title">{row.title}</span>
            {row.text ? <span className="Admin-link-text" style={{ display: "block" }}>{row.text}</span> : null}
          </span>
          {row.badge}
          <s-icon type="chevron-right" color="subdued" />
        </GuardedLink>
      ))}
    </div>
  );
}

/**
 * 店舗などを選ぶ一覧（POS Stock のロケーション選択と同じ形）。上に「すべて」の行、項目が多いときは絞り込み欄。
 * 選んだ行は青い枠。allLabel の行を選ぶと個別の選択は外れる。value は選んだ id（空＝すべて）。
 */
export function PickList({
  label,
  items,
  value,
  onChange,
  allLabel,
  name,
  emptyText = "選べる項目がありません。",
}: {
  label: string;
  items: { id: string; name: string; note?: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  allLabel?: string;
  name?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const shown = query.trim() ? items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())) : items;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  return (
    <div role="group" aria-label={label}>
      {items.length > 6 ? (
        <div className="Admin-pick-search" data-not-form-value>
          <input type="search" className="Admin-input" placeholder={`${label}を絞り込む`} aria-label={`${label}を絞り込む`} value={query}
            onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
        </div>
      ) : null}
      <div className="Admin-pick">
        {allLabel ? (
          <label className="Admin-pick-row" data-selected={value.length === 0}>
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            <span className="Admin-pick-name">{allLabel}</span>
          </label>
        ) : null}
        {shown.map((item) => (
          <label key={item.id} className="Admin-pick-row" data-selected={value.includes(item.id)}>
            <input type="checkbox" checked={value.includes(item.id)} onChange={() => toggle(item.id)} />
            <span className="Admin-pick-name">{item.name}</span>
            {item.note ? <span className="Admin-note">{item.note}</span> : null}
          </label>
        ))}
        {items.length === 0 ? <p className="Admin-note" style={{ margin: 8 }}>{emptyText}</p> : null}
        {items.length > 0 && shown.length === 0 ? <p className="Admin-note" style={{ margin: 8 }}>「{query}」に合うものはありません。</p> : null}
      </div>
      {value.length > 0 ? <p className="Admin-pick-count">{value.length} 件を選択中</p> : null}
      {name ? value.map((id) => <input key={id} type="hidden" name={name} value={id} />) : null}
    </div>
  );
}

/** 未保存の入力がある画面の数。メニューやボタンで移るときに Shopify の「変更を破棄しますか」を出す。 */
const dirtyForms = new Set<string>();
/** Shopify の保存の帯は一度に1つしか出せない。先に変えたフォームの帯を出し、それを保存か破棄したら次のフォームの帯を出す（986af6d 監査 P1） */
const barListeners = new Set<() => void>();
function activeBar(): string | null {
  for (const id of dirtyForms) return id;
  return null;
}
function notifyBars() {
  for (const listener of barListeners) listener();
}

async function confirmLeave(): Promise<boolean> {
  if (dirtyForms.size === 0) return true;
  const shopify = typeof window === "undefined" ? undefined : (window as unknown as { shopify?: { saveBar?: { leaveConfirmation?: () => Promise<void> } } }).shopify;
  if (!shopify?.saveBar?.leaveConfirmation) return true;
  await shopify.saveBar.leaveConfirmation();
  dirtyForms.clear();
  notifyBars();
  return true;
}

/** 画面内のリンクとボタン型リンク。未保存の変更があるときは移る前に確認する。 */
export function GuardedLink({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; "aria-current"?: "page"; "aria-label"?: string }) {
  const navigate = useNavigate();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (dirtyForms.size === 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    void confirmLeave().then(() => navigate(to));
  };
  return <Link to={to} className={className} onClick={onClick} {...rest}>{children}</Link>;
}

export function PrimaryLink({ to, children, icon }: { to: string; children: ReactNode; icon?: string }) {
  return (
    <GuardedLink to={to} className="Admin-primary">
      {icon ? <s-icon type={icon as "plus"} /> : null}
      {children}
    </GuardedLink>
  );
}

/** ほかの画面へ移るボタン（文字だけのリンクは分かりにくいので、ボタンの見た目にする。11/20 T）。small は表の中の「編集」など */
/**
 * 前の画面へ戻る「←」（VIP と同じ枠なしのボタン）。メニューから直接開けない下の階層の画面に付ける。
 * s-page の breadcrumb-actions は Shopify 管理画面の上の帯に文字で出るだけで、アプリの画面の中には何も出ない（11/21 T「まだ出てない」）。
 * そのため画面の中の左上にも「←」だけのボタンを置く（触れたときだけ灰色の角丸の背景）。帯の文字は戻り先の画面名にする。
 * s-page の直下、Admin-body の前に置く。
 */
export function BackAction({ to, label }: { to: string; label: string }) {
  const parent = label.replace(/へ戻る$/, "");
  return (
    <>
      <s-link slot="breadcrumb-actions" href={to}>
        {parent}
      </s-link>
      <div className="Admin-back">
        <GuardedLink to={to} className="Admin-back-button" aria-label={label}>
          <s-icon type="arrow-left" />
        </GuardedLink>
      </div>
    </>
  );
}

export function SecondaryLink({ to, children, small = false, icon }: { to: string; children: ReactNode; small?: boolean; icon?: string }) {
  return (
    <GuardedLink to={to} className={small ? "Admin-secondary Admin-button-sm" : "Admin-secondary"}>
      {icon ? <s-icon type={icon as "plus"} /> : null}
      {children}
    </GuardedLink>
  );
}

/**
 * 保存は Shopify 標準の保存の帯（11/20 T）。囲んでいるフォームの入力が変わると Shopify の一番上に「破棄」「保存」が出る。
 * 送信すると帯を閉じ、結果（status）をトーストで知らせる。失敗は赤いトーストと、各画面の欄の下の赤い文字で知らせる。
 * 未保存のままメニューやボタンで移ろうとすると、Shopify の確認を出す。
 * 画面内の保存ボタンは置かない。
 */
export function SaveBar({
  status,
  tone = "success",
  onDiscard,
  failed = false,
}: {
  status?: ReactNode;
  /** 直前の保存が失敗したか（失敗のあとは帯をもう一度出す） */
  failed?: boolean;
  tone?: "success" | "warning" | "critical";
  /** 「破棄」のとき、React の状態で持っている入力（ランク表・選んだ商品など）を元に戻す */
  onDiscard?: () => void;
  /** 以前の画面内の保存ボタン。Shopify の帯に移したので描かない（呼び出し側の互換のため受け取る） */
  children?: ReactNode;
}) {
  const id = "save-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const marker = useRef<HTMLSpanElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const shopify = useAppBridge();
  const lastStatus = useRef<ReactNode>(undefined);
  const form = () => marker.current?.closest("form") ?? null;

  // 保存した時点（または開いた時点）のフォームの値。帯は「今の値がこれと違うとき」だけ出す。
  // 保存の帯を押したときに欄から外れて遅れて届く change や、部品の作り直しで届く input では帯を出し直さない（T 11/21「何回か押さないと保存されない」）
  const baseline = useRef<string | null>(null);
  const beforeSubmit = useRef<string | null>(null);
  // 保存に失敗したときは、送る前の値と比べ直す（直さずにもう一度保存できるよう、帯を出し直す）
  useEffect(() => {
    const element = form();
    if (!failed || !element) return;
    baseline.current = beforeSubmit.current;
    setDirty(formSnapshot(element) !== baseline.current);
  }, [failed]);
  useEffect(() => {
    const element = form();
    if (!element) return;
    const capture = () => { baseline.current = formSnapshot(element); };
    const timer = window.setTimeout(capture, 0);
    // 絞り込みの入力など、フォームの値でない欄は保存の帯を出さない（PR #61 監査 P2）
    const mark = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-not-form-value]")) return;
      // React の状態で持つ入力（ランクの表など）は描き直しのあとで値が変わるので、次の描画のあとで比べる
      window.requestAnimationFrame(() => {
        const now = formSnapshot(element);
        if (baseline.current === null) baseline.current = now;
        setDirty(now !== baseline.current);
      });
    };
    // 送信したら帯を閉じる。入力の誤りで戻ったときは、画面の赤いお知らせと欄の下の赤い文字で知らせ、直すとまた帯が出る
    const sent = () => { beforeSubmit.current = baseline.current; capture(); setDirty(false); };
    const reset = () => window.setTimeout(capture, 0);
    element.addEventListener("input", mark);
    element.addEventListener("change", mark);
    element.addEventListener("submit", sent);
    element.addEventListener("reset", reset);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("input", mark);
      element.removeEventListener("change", mark);
      element.removeEventListener("submit", sent);
      element.removeEventListener("reset", reset);
    };
  }, []);

  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const listener = () => setActive(activeBar());
    barListeners.add(listener);
    return () => { barListeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (dirty) dirtyForms.add(id);
    else dirtyForms.delete(id);
    notifyBars();
    return () => { dirtyForms.delete(id); notifyBars(); };
  }, [dirty, id]);

  useEffect(() => {
    const previous = lastStatus.current;
    lastStatus.current = status;
    // トーストは成功のときだけ。失敗は消えるトーストにせず、画面の赤いお知らせと欄の下に残す（Built for Shopify 4.2.4）
    if (!status || status === previous || tone === "critical") return;
    const text = typeof status === "string" ? status : "保存しました";
    try {
      shopify.toast.show(text);
    } catch {
      // App Bridge が無い（テストなど）ときは画面内の表示だけにする
    }
  }, [status, tone, shopify]);

  const save = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const element = form();
    if (!element) return;
    if (!element.reportValidity()) return;
    element.requestSubmit();
  };
  const discard = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    form()?.reset();
    onDiscard?.();
    setDirty(false);
  };

  return (
    <>
      <span ref={marker} hidden data-save-bar={id} />
      <AppSaveBar id={id} open={dirty && active === id}>
        <button type="button" variant="primary" onClick={save}>保存</button>
        <button type="button" onClick={discard}>破棄</button>
      </AppSaveBar>
    </>
  );
}

/** フォームの今の値を1つの文字列にする（保存の帯を出すかの比較用。ファイルは名前と大きさだけ） */
function formSnapshot(element: HTMLFormElement): string {
  const pairs: string[] = [];
  for (const [key, value] of new FormData(element)) {
    pairs.push(`${key}=${typeof value === "string" ? value : `${value.name}:${value.size}`}`);
  }
  return JSON.stringify(pairs);
}

/** 入力欄を JS で書き換えたとき（商品の選択など）に、保存の帯を出すため変更を知らせる。 */
export function markFormDirty(element: Element | null | undefined) {
  element?.closest("form")?.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 成功の知らせをトーストで出す（画面に残さない）。message が変わるたびに1回出す。 */
export function SuccessToast({ message, trigger }: { message?: string | null; trigger?: unknown }) {
  const shopify = useAppBridge();
  const last = useRef<unknown>(undefined);
  useEffect(() => {
    // trigger（保存の結果）を渡すと、同じ文でも保存のたびに出す（2回目の保存でトーストが出ず、保存できたか分からなかった。T 11/21）
    const key = trigger ?? message;
    if (!message || key === last.current) return;
    last.current = key;
    try {
      shopify.toast.show(message);
    } catch {
      // App Bridge が無いときは何もしない
    }
  }, [message, trigger, shopify]);
  return null;
}

/** 画面を移る間は Shopify 上端の細い進捗線を出す。 */
export function LoadingIndicator({ loading }: { loading: boolean }) {
  const shopify = useAppBridge();
  useEffect(() => {
    try {
      shopify.loading(loading);
    } catch {
      // App Bridge が無いときは何もしない
    }
  }, [loading, shopify]);
  return null;
}

export function PrimaryButton({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  return (
    <button type="submit" className="Admin-primary" disabled={disabled}>
      {children}
    </button>
  );
}

export function SecondaryButton({ children }: { children: ReactNode }) {
  return (
    <button type="submit" className="Admin-secondary">
      {children}
    </button>
  );
}

/** 横スライドのメニューで、今のページの項目が見える位置まで送る（スマホ幅で後ろの項目を開いたとき） */
function scrollActiveIntoView(nav: HTMLElement | null) {
  if (!nav || nav.scrollWidth <= nav.clientWidth) return;
  const active = nav.querySelector<HTMLElement>("a.is-active");
  if (!active) return;
  const left = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
  nav.scrollLeft = Math.max(0, left);
}

export function AppNavBarView({
  items,
  pathname,
  search,
}: {
  items: { path: string; label: string; match?: string[] }[];
  pathname: string;
  search: string;
}) {
  return (
    <nav className="Admin-nav" data-app-nav="shop-point" aria-label="アプリ" ref={scrollActiveIntoView}>
      {items.map((item) => {
        // 親の画面の下の編集画面（/app/earn-rules/earn など）でも親を選択中にする
        const active = pathname === item.path || (item.path !== "/app" && pathname.startsWith(`${item.path}/`))
          || (item.match ?? []).some((path) => pathname === path || pathname.startsWith(`${path}/`));
        return (
          <GuardedLink
            key={item.path}
            to={item.path + search}
            className={active ? "is-active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </GuardedLink>
        );
      })}
    </nav>
  );
}
