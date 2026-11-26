# Two-tenant PostgreSQL16 recovery acceptance — 2026-11-26

Owner: Codex POS; base PR155 ce900fced919d36bfbccbd87e8e3615c3e6a79aa. Runtime/schema/package/lock/TTL/live cron/Store settings unchanged. Dedicated test-only branch.

## New boundary
Two synthetic shops share item11/location22/timestamps but use different baselines/anchors (10→8→10 and100→90→100). Real Prisma6.19.1 from parent package-lock and ephemeral PostgreSQL16/TCP persist history, retained observations and sessions. Separate Node processes execute actual webhook/daily routes. Shopify/refresh/snapshot ports remain synthetic, external fetch forbidden, output anonymous IPC only.

Only shop A initially has an offline session. The authenticated daily action must recover A using only A chronology, report B failure and retain B observation/history. After creating B's synthetic offline session in the same isolated DB, a fresh PID daily call must recover B with +10 while A remains +2 and unchanged. A later duplicate call must leave two history rows per tenant and no pending observations. This is two-tenant coverage, not all interleavings, tenants, queue/load or store acceptance.

The CI adds this new suite alongside the previous1shop suite (old evidence not scored again). It then removes only the shop predicate from the daily session selector in the isolated checkout; the **specific restored-tenant matching-session assertion** must fail before the candidate route is byte-restored. The existing internal shop/session guard is not removed, so this control proves detection of wrong session selection, not a demonstrated production cross-shop write. Old parent-route control still proves only nonzero exit and byte restore.

## Execution and gates
`RUN_POS_PG_RECOVERY=1 DATABASE_URL=postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test node --test --test-concurrency=1 --test-reporter=tap tests/inventory-observation-pg-recovery.test.mjs tests/inventory-observation-tenant.pg-acceptance.mjs`

The inherited explicit local database guard runs before Prisma construction. The CI service is disposable, no Actions secrets/production credentials or external inventory writes. No local PG16 available; default skip is not pass. Read exactHEAD CI and independent review before accepting. Full migration chain, full app lint/types/build, real Store/device/paper, live curl command/cadence, retention/load and POS-ZERO-RETRY-001 operational acceptance remain open. Parent153→154→155 integration/deployment gates remain unchanged. Baseline92/63 maintained until root evaluates a new accepted checkpoint.

