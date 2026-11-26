# PostgreSQL16 / Prisma process acceptance — 2026-11-26

Owner: Codex POS. Fixed runtime parent: PR154 `34e669ce3b2763fadb7c8229fd270da7aeb2110f`, stacked on PR1536280. No runtime/schema/TTL/deploy/cron configuration changes in this test-only candidate.

## Boundary
GitHub Actions PostgreSQL16 service, real lockfile-pinned Prisma6.19.1 generated from the parent schema, TCP localhost only. The guard requires opt-in and the exact disposable localhost:5432/commercor_test URL with synthetic test credentials and no query/hash. The service is ephemeral and separate from Render/shared/live DB. Schema setup uses current parent schema db push, **not a certification of every historical migration**.

The test starts separate Node processes that execute actual webhook/daily routes through Vite. Prisma history/observations/session reads and writes are real. External Shopify/SDK refresh/snapshot ports remain synthetic; fetch is blocked and no real store is contacted. Child logs are suppressed; only anonymous phase/count results cross IPC.

Checks: retained observation survives a failed refresh and process exit, a later existing daily invocation recovers without a new inventory event; two separately connected workers select the same row behind a barrier, release together and leave exactly one history row; an injected observation-cleanup failure after a real history write preserves the observation, then fresh-process retry deletes it without duplicate history. Final DB state is asserted. A parent-main daily-route sensitivity run on the same already-proven service must fail; candidate file is restored and byte-compared afterward.

## Command
`RUN_POS_PG_RECOVERY=1 DATABASE_URL=postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test node --test --test-reporter=tap tests/inventory-observation-pg-recovery.test.mjs`

Without opt-in it skips and this is not PG success. Local PG16 server is unavailable in this execution environment. Exact PR HEAD Actions results and independent review must be read before calling this boundary passed. No Actions secrets, prod credentials, permissions mutations, real data, deployment, inventory or messages are used. Full app lint/type/build and real store/device/cron command/cadence acceptance remain separate. POS-ZERO-RETRY-001 operational acceptance is still open; scores92/62 remain until new evidence is accepted.


## Reproducibility correction
Initial eefb CI passed real PG16/TCP process acceptance, but generated Prisma6.19.3 differed from parent package-lock6.19.1 despite the temporary tool install request. It is evidence for that measured version only. The workflow now runs repository npm ci with lifecycle scripts disabled, then explicitly generates the client; the test asserts actual generated client equals the parent repository lock before touching fixture data. Final exactHEAD CI and independent review must be read again; no runtime/package/lock contents changed.
