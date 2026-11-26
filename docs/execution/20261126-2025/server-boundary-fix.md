# Server-only inventory webhook boundary

Parent PR158 5f4c2af5c115f1a3464a2719b1d2b3f8739d5bd6 failed candidate build in CI45812786991: replayStoredInventoryObservation was exported by a route and imported by the daily route, retaining webhook-auth-safe.server in the client graph. Main94fb built successfully.

Move the handler verbatim to inventory-webhook-handler.server.ts; only the filename banner and action export alias change. Keep the webhook route's framework action wrapper and use the server-only module from the existing authenticated daily endpoint. Auth, webhook budget, stock history classification, pending sales/refunds, replay, tenant checks and daily drain behavior stay identical. No schema, UI, configuration or deployment changes.

The relocation hash guard proves the entire parent handler body including final action is byte-equivalent after reversing those two mechanical edits. Existing source-inspection/VM tests now target the server module; Vite action integration tests still exercise the actual route wrapper. Local selected66 passed; exact-head CI adds2 boundary guards plus the full main/candidate type/lint/build comparison. Parent candidate build failure is a before control, not a healthy release.

Full app type/lint debt is not waived. This candidate is not approved for integration, migration or Store acceptance by these tests. Actual Render DB/curl cadence/Store/iPhone/iPad/POS inventory remain unverified.

The first fixed candidate build succeeds. The original filename-keyed reporter then counts five unchanged TypeScript and three lint diagnostics as added solely because the handler moved. The final reporter retains raw counts and aliases only that single diagnostic filename after reversing the two mechanical edits and verifying the entire exact parent body hash; code/fullmessage/multiplicity are unchanged, no debt is waived, and a changed handler fails the alias guard. All458 TypeScript errors remain in the total. FullQualityGreen remains false.
