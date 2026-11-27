# Deployed runtime compatibility with forward database — 2026-11-28 06:00 JST

Owner Codex renderpos0528; base167 cfe3b15c671f30b5d6ab0a63bab2d222600b3af8.
This checks the remaining rollback-runtime compatibility boundary using only an
owned disposable PG16 database and the already established positive synthetic fixture.

Apply current 13 migrations and seed the existing session/history/retained observation.
Materialize exact deployed main94fb3ea579904f65b9df9306aa7da31f84d16d06 into a temporary archive,
generate its original Prisma client, run its migration setup and build, then actually
start that compiled app and invoke its original CLI. Capture all columns of migration
history, sessions, history and retained observations before/after: old snapshot work
must preserve them. The legacy runtime does not claim observation recovery.
Regenerate current client/build and use the existing strict caller acceptance to
recover the preserved observation once and preserve migration history.

No schema downgrade/down migration, production rollback, dump/PITR, actual Render
deployment, Store, device or stock acceptance is demonstrated. This is not full
rollback safety. Old caller partial-failure semantics remain a known limitation;
this positive fixture does not resolve POS-RENDER-001/002. No new auth/receiver
exploration; fixed existing positive transport fixture only. Runtime/schema/CLI/
lock/flags/UI unchanged. Existing type454/lint3117 and fullQualityGreen=false remain.
Exact-HEAD CI, distinct A1 review and real author receipt are required.
Prior restore/compiled/strict replay and test counts do not earn points again.

Evidence precision correction: capture the existing full-table checkpoint immediately after seed and verify it after legacy setup/runtime, so old setup itself cannot silently modify the baseline. Initial test captured four tables only after old setup. This harness strengthening earns no extra points and performs no native dump/restore.
