# Real HTTP cron candidate acceptance

Base PR15912a930 preserves the strict Node caller from PR154. Earlier caller tests replaced fetch; this isolated test adds actual child Node process → loopback HTTP socket coverage and observes OS exit, POST/Authorization, chunked response completion, HTTP500, malformed JSON, recovery failure/malformed flag, and reset connection. A real curl subprocess receives the same synthetic HTTP200 partial reply and exits zero, while the existing strict Node caller exits one. No API implementation, caller, cron configuration, schema, UI, Store data or deployment changes.

Every HTTP server is bound dynamically to 127.0.0.1; URL is created from that server, never user/environment supplied. Child env contains only PATH and fixture URL/key. Real payload canaries are synthetic and must not occur in the strict caller output. No dependency install, generated client, DB service, SDK or external endpoint is used. Requests and subprocess deadlines are finite.

This does not certify the real Render curl invocation/cadence or recovery runtime, DB state, Store/device/inventory, full app quality, or deployment. Live cron remains unchanged. Its previous partialfailure POS-RENDER-001 remains unresolved until authenticated actual counters/operational acceptance. This is a transport candidate boundary, not production remediation.
