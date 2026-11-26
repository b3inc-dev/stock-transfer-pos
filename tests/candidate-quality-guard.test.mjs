import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertQualityFixture} from '../scripts/observe-candidate-quality.mjs';
const env={CI:'true',GITHUB_ACTIONS:'true',GITHUB_WORKSPACE:'/fixture',DATABASE_URL:'postgresql://quality:synthetic-only@127.0.0.1:1/no_connection',SHOPIFY_APP_URL:'https://quality.invalid',SHOPIFY_API_KEY:'00000000000000000000000000000000',SHOPIFY_API_SECRET:'synthetic-quality-only'};
test('quality observation accepts only isolated no-connection build inputs',()=>assert.doesNotThrow(()=>assertQualityFixture(env,'/fixture')));
test('quality observation rejects other credentials, database and surface before commands without exposing canaries',()=>{
 for(const key of Object.keys(env)){
  let error;try{assertQualityFixture({...env,[key]:'SENSITIVE-CANARY'},'/fixture');}catch(e){error=e;}
  assert.ok(error);assert.doesNotMatch(String(error.stack)+JSON.stringify(error),/SENSITIVE-CANARY/);
 }
});
