# Compiled production-start acceptance

Previous161 accepted a custom HTTP adapter calling the daily action via Vite mocks. This new test builds the actual application and starts the unchanged npm start/react-router-serve process. It uses real HTTP routing to the compiled daily action, real Prisma/TCP PG16 and child strict CLI, with no custom HTTP adapter or source-module alias. It checks401/no DB writes, GET400/no writes, +2 retained recovery and repeat idempotency.

Only outbound global fetch to the exact synthetic full-start-pg.invalid Admin GraphQL address is answered by a fixture; unknown fetch is denied and anonymously audited in an exclusive temporary directory. Snapshot parsing/aggregation/save and offline session storage are the actual compiled source. This does not exercise real Shopify API correctness. No actual credentials, Store data or inventory API is supplied. FixtureURL/opt-in guards precede server imports/DDL.

A disposable loopback port is reserved then released before starting the isolated server; a race is possible and readiness is bounded. Cleanup signals only the test's own detached npm process group and deletes synthetic DB fixtures/temp audit. Local PG/full dependencies unavailable means guard-only plus skip, not a production-start pass. Runtime/schema/SQL/caller/config/cron/UI/deployment remain unchanged.

Even successful CI is not a live Render deploy/cron/Store/device acceptance or resolution of POS-RENDER-001/002. Full type/lint debt, real DB drift/restore/rollback and integration-owner receipt remain incomplete.

Startup audit: entry.server/shopify.server/db.server/root contain request rendering and SDK/Prisma constructors, no explicit scheduler startup. The test runs npm start only (not setup, deploy or cron), supplies no dispatch/worker credentials, and the fixture rejects setInterval scheduling as well as unknown fetch. Background periodic dispatch must remain inactive; this is a guard, not a newly invented production configuration.

Initial8bb CI built and started the app, verified POST401/no writes, then stopped on our incorrect GET405 expectation. The actual current no-loader resource route returns400. The test records that observed rejection contract and verifies unchanged DB; no runtime HTTP behavior was modified.
