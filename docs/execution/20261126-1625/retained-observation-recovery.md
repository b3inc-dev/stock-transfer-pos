# Existing-trigger retained observation recovery candidate — 2026-11-26

Owner: Codex POS workstream. Parent: PR153 `6280eed56d105e765f3d2136b45ca3abcd6ee743`; parent runtime main `94fb3ea579904f65b9df9306aa7da31f84d16d06`. No main/staging/UI-owner branch changed.

## Trigger and scope
`respondWithinBudget` acknowledges after four seconds but has no durable retry. This candidate reuses the existing Bearer-key-authenticated `/api/inventory-snapshot-daily` action. It attempts at most 25 retained rows per invocation, with a two-second admission budget checked before each row. In-flight session/GraphQL work is not force-cancelled; this is not a hard wall-clock limit. Rows rotate by NULLS FIRST/oldest lastAttemptedAt. No new timer, cron, schema, TTL, schedule, Shopify inventory write or incoming-webhook auth change.

Each row loads its own matching offline session before calling the existing history handler/classifier. Missing/mismatched session and failures preserve the row. HTTP200 alone is insufficient: a surviving row is accepted as retained only when its previous quantity proves a true zero delta. Snapshot and recovery counters both influence API ok. A failed daily attempt can be retried on the next existing daily invocation without another inventory notification.

The existing CLI now checks HTTP/body/counters and exits nonzero on partial snapshot/recovery failure, printing anonymous counts only. **Observed live Render cron commands still use curl**, not this Node script. No Render configuration was changed. The candidate API response improves evidence, but production cron process exit remains an operational acceptance item until a separately authorized command change. Batch-limit success does not certify an empty global queue.

## Reproduction
```sh
node --test --test-reporter=tap tests/inventory-observation-daily-recovery.test.mjs tests/inventory-snapshot-cron-result.test.mjs
node --test --test-reporter=tap tests/inventory-history-order.test.mjs tests/inventory-webhook-zero-observation.test.mjs tests/pending-sale-history.test.mjs tests/compliance-webhook.test.mjs
```
New selected tests: 11 pass, no fail/skip. Replacing only the daily route with parent main makes the no-new-webhook recovery assertion fail; candidate passes. Auth-before-data, tenant session denial, failure preservation, next-trigger recovery, duplicate suppression, true-zero hidden preservation, admission budget and strict/anonymous CLI counts are covered.

Supplementary isolated PGlite 0.3.14/PostgreSQL17.5 WASM test applies parent153's existing migration and persists the retained row, then demonstrates failed refresh preserving it and next daily invocation promoting/deleting it: 1 pass. Actual history/session/Shopify ports are synthetic; timestamp-without-time-zone is explicitly parsed as UTC for Prisma-compatible fixture semantics. This is not Prisma TCP/PG16 or full database integration. No dependency/schema/package change is included.

## Remaining acceptance
Independent exact-HEAD review, real Prisma/PG16 concurrency and transaction behavior, full app type/build, permitted store/device acceptance, retention volume/load, deployed cron command and cadence/latency, and operational next-trigger evidence remain unverified. Parent153 must be accepted before this stacked branch. No merge, migration, actual daily invocation, deployment, config/DB write, inventory/notification or public enablement was performed. Scores remain custom92/public62 until a separately recorded accepted checkpoint.

