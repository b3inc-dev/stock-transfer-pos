import assert from 'node:assert/strict';

export function assertIsolatedRecoveryDatabase(){
 assert.equal(process.env.RUN_POS_PG_RECOVERY,'1','explicit isolated PG acceptance opt-in required');
 const url=new URL(process.env.DATABASE_URL);
 assert.equal(url.protocol,'postgresql:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5432');
 assert.equal(url.pathname,'/commercor_test');assert.equal(url.username,'postgres');assert.equal(url.password,'test-only-local');
 assert.equal(url.search,'');assert.equal(url.hash,'');
}
