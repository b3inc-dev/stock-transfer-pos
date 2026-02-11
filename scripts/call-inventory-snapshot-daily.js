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

    if (!response.ok) {
      console.error(`Error: HTTP ${response.status}`);
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log('Success:');
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error calling API:');
    console.error(error.message);
    process.exit(1);
  }
}

callApi();
