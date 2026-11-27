# Cumulative PR162 quality observation (2026-11-28 02:21 JST)

Owner: Codex renderpos0026. Base candidate: bdecd0527011c02a11f8f2e8cbadf4bae95e4849 (PR162); comparison main: 94fb3ea579904f65b9df9306aa7da31f84d16d06. Dedicated isolated branch: codex/cumulative-quality-20261128-0221.

The existing candidate-quality-observation workflow did not select PRs based on the PR162 branch. Add that single branch to its pull_request base filter so the unchanged collector can observe the current cumulative candidate. Runtime, tests, package/lock, schema, UI, and the collector remain unchanged. This is a finite validation preparation step, not a timeout policy or runtime repair.

The job checks out the PR HEAD explicitly, uses Node 22.14.0 and npm ci --ignore-scripts, guards synthetic inputs, materializes fixed main separately using the same lock and dependency directory, and runs existing regressions plus the original full type/lint/build comparison. It has no database service; PostgreSQL points to loopback port 1. Preserve all command statuses and diagnostic counts. A successful observation job is not full quality green. PR159's earlier 458 type / 3118 lint / build success is historical and must not be reused as this cumulative HEAD's result.

Completion: record the new exact HEAD/run/job, actual checkout and full diagnostic comparison, any introduced diagnostics, and independent review. If observation fails, preserve failure rather than broadening scope to legacy debt. Until CI completes, this document records a procedure only, not a passing result. Preparation and repeated known-debt evidence score 0 points.

No app merge/deployment, feature flag changes, database or real store/data/inventory operations, delivery or costs are authorized. Existing Ciara273 distribution is unchanged; device and printing acceptance remain unverified. Final staging/deployment owner receipt is not inferred from posting this document.
