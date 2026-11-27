# Snapshot static debt reduction — 2026-11-28 05:28 JST

Owner: Codex renderpos0528. Base PR166 exact 5dd57d3525c879a101c48fbaa241273489b1fa70.
The current snapshot aggregate accesses properties on unknown inventory items.
Introduce a private shape containing only the fields already read, assert that shape
at the existing iteration, and keep downloaded JSON output unknown instead of any.

This is a static contract correction, not response validation. Malformed Shopify
payload handling and all existing aggregate, network, write, retry and error behavior
remain unchanged. The CI asserts byte-identical TypeScript emitted JavaScript
(removeComments, ES2022/ESNext) against the exact parent, strictly checks this module,
runs existing business regressions, then compares whole type/lint/build to main.
No disabling rules, ts-ignore, lock/schema/auth/UI changes. Global debt is not waived.
No real Store/DB, deploy, inventory, dispatch, cost or live receiver auth work.

Independent A1 exact-HEAD review and author receipt are required before Ready.
Actual CI counts and residuals will be recorded in PR/#79; this document is not a pass.
