#!/usr/bin/env node
// scripts/call-inventory-snapshot-daily.js
// Render Cron Job用：在庫スナップショットAPIを呼び出すスクリプト

const apiUrl = process.env.INVENTORY_SNAPSHOT_API_URL || process.argv[2];
const apiKey = process.env.INVENTORY_SNAPSHOT_API_KEY;

if (!apiUrl) {
  console.error('Error: API URL is required');
  console.error('Usage: node scripts/call-inventory-snapshot-daily.js <API_URL>');
  console.error('Or set INVENTORY_SNAPSHOT_API_URL environment variable');
  process.exit(1);
}

if (!apiKey) {
  console.error('Error: INVENTORY_SNAPSHOT_API_KEY environment variable is required');
  process.exit(1);
}

async function callApi() {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    const count = value => Number.isSafeInteger(value) && value >= 0;
    const errors = Array.isArray(data.errors) ? data.errors.length : data.errors == null ? 0 : Number.isSafeInteger(data.errors) && data.errors >= 0 ? data.errors : -1;
    const recovery = data.observationRecovery;
    const validRecovery = recovery && ['scanned','attempted','completed','retained','failed','deferred'].every(key => count(recovery[key])) &&
      recovery.attempted === recovery.completed + recovery.retained + recovery.failed && recovery.scanned === recovery.attempted + recovery.deferred;
    const success = response.ok && data.ok === true && count(data.processed) && count(data.total) && data.processed === data.total && errors === 0 &&
      validRecovery && recovery.failed === 0 && recovery.deferred === 0;
    // Never print raw response/error strings, shop names, keys or customer data.
    const summary = { ok: Boolean(success), status: response.status, processed: count(data.processed) ? data.processed : null, total: count(data.total) ? data.total : null, errors: errors < 0 ? null : errors,
      observationRecovery: validRecovery ? Object.fromEntries(['scanned','attempted','completed','retained','failed','deferred','batchLimitReached'].map(key => [key, recovery[key]])) : null };
    console.log(JSON.stringify(summary));
    process.exit(success ? 0 : 1);
  } catch {
    console.error('Error calling API:');
    console.error('Snapshot request failed; inspect the authenticated service logs.');
    process.exit(1);
  }
}

callApi();
