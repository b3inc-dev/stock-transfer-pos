import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('server relocation preserves the exact parent handler body and export alias only',()=>{
 const handler=read('app/utils/inventory-webhook-handler.server.ts').replace('// app/utils/inventory-webhook-handler.server.ts','// app/routes/webhooks.inventory_levels.update.tsx').replace('export const inventoryWebhookAction =','export const action =');
 assert.equal(createHash('sha256').update(handler).digest('hex'),'7d0247aedadbd429428286c7cd2a7f395b778d806cc3ad9cd94a8d2dd7b9ac25');
});
test('route keeps only the framework action export and daily imports the server module',()=>{
 const route=read('app/routes/webhooks.inventory_levels.update.tsx');
 assert.equal((route.match(/export /g)||[]).length,1);
 assert.match(route,/export const action = \(args: ActionFunctionArgs\) => inventoryWebhookAction\(args\)/);
 assert.ok(!route.includes('replayStoredInventoryObservation'));
 const daily=read('app/routes/api.inventory-snapshot-daily.tsx');
 assert.ok(daily.includes('from "../utils/inventory-webhook-handler.server"'));
 assert.ok(!daily.includes('from "./webhooks.inventory_levels.update"'));
});
