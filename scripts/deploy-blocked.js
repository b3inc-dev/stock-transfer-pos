#!/usr/bin/env node
/**
 * `npm run deploy` を止める（T さんの決定 2026-11-22）。
 * `shopify app deploy` をそのまま動かすと APP_MODE の見張り（verify-app-mode.js）を通らないため、
 * 何も deploy せずに案内を出して exit 1 で終わる。
 */
console.error("deploy:inhouse か deploy:public を使ってください");
console.error("  npm run deploy:inhouse   # 自社用（POS Stock - Ciara・shopify.app.toml）");
console.error("  npm run deploy:public    # 公開用（POS Stock・shopify.app.public.toml）");
console.error("npm run deploy は APP_MODE の見張りを通らないので止めています（docs/DEPLOY.md §3）。");
process.exit(1);
