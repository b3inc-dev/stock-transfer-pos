import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {authenticateWebhookSafely, isValidWebhookHmac} from "../app/utils/webhook-auth-safe.ts";
const secret="synthetic-regression-secret-only";
const body='{\n "customer": {"id": 101, "note": "検証🙂"}, "x": " a b "\n}';
const sign=raw=>crypto.createHmac("sha256",secret).update(raw,"utf8").digest("base64");
const headers=(raw=body,alternate=false)=>({
 [alternate?"shopify-hmac-sha256":"x-shopify-hmac-sha256"]:sign(raw),
 [alternate?"shopify-shop-domain":"x-shopify-shop-domain"]:"audit.myshopify.com",
 [alternate?"shopify-topic":"x-shopify-topic"]:"customers/redact",
 "x-shopify-api-version":"2026-10","x-shopify-webhook-id":"synthetic-event",
});
const request=(raw=body,h=headers())=>new Request("https://audit.invalid/webhooks/compliance",{method:"POST",headers:h,body:raw});
const sdk500=async r=>{await r.text();throw new Response(null,{status:500});};
const silent={log:()=>{}};
test("raw UTF-8 body signature is exact: whitespace or serialization changes are refused",()=>{
 assert.equal(isValidWebhookHmac(body,sign(body),secret),true);
 assert.equal(isValidWebhookHmac(JSON.stringify(JSON.parse(body)),sign(body),secret),false);
 assert.equal(isValidWebhookHmac(body+" ",sign(body),secret),false);
});
test("every body byte mutation is refused against the original signature",()=>{
 const bytes=Buffer.from(body,"utf8");
 for(let i=0;i<bytes.length;i++){const changed=Buffer.from(bytes);changed[i]^=1;assert.equal(isValidWebhookHmac(changed.toString("utf8"),sign(body),secret),false,"byte="+i);}
});
test("each digest byte mutation and wrong lengths are refused",()=>{
 const digest=Buffer.from(sign(body),"base64");
 for(let i=0;i<digest.length;i++){const changed=Buffer.from(digest);changed[i]^=1;assert.equal(isValidWebhookHmac(body,changed.toString("base64"),secret),false,"digest="+i);}
 for(const h of ["","not-a-digest","AAAA",digest.subarray(0,31).toString("base64"),Buffer.alloc(33).toString("base64")])assert.equal(isValidWebhookHmac(body,h,secret),false);
});
test("missing/wrong secret and missing header are refused",()=>{
 assert.equal(isValidWebhookHmac(body,sign(body),""),false);
 assert.equal(isValidWebhookHmac(body,sign(body),"other-synthetic"),false);
 assert.equal(isValidWebhookHmac(body,null,secret),false);
});
test("SDK success is preserved by identity without invoking fallback",async()=>{
 const expected={topic:"SDK_TOPIC",shop:"sdk.myshopify.com",payload:{safe:true}};
 let logs=0;
 assert.equal(await authenticateWebhookSafely(request(),{authenticateWebhook:async r=>{await r.text();return expected;},apiSecret:"",log:()=>logs++}),expected);
 assert.equal(logs,0);
});
test("SDK500 after consuming the request uses the cloned raw body, not normalized JSON",async()=>{
 const value=await authenticateWebhookSafely(request(),{authenticateWebhook:sdk500,apiSecret:secret,...silent});
 assert.deepEqual(value.payload,JSON.parse(body));assert.equal(value.topic,"CUSTOMERS_REDACT");
 assert.equal(value.shop,"audit.myshopify.com");assert.equal(value.session,undefined);assert.equal(value.admin,undefined);
 assert.equal(value.sessionRefreshFailed,true);assert.equal(value.webhookId,"synthetic-event");
});
test("invalid signature on SDK500 returns 401 and never logs an accepted fallback",async()=>{
 let logs=0;
 await assert.rejects(authenticateWebhookSafely(request(body,{...headers(),"x-shopify-hmac-sha256":"bad"}),{authenticateWebhook:sdk500,apiSecret:secret,log:()=>logs++}),e=>e instanceof Response&&e.status===401);
 assert.equal(logs,0);
});
test("changing the body after signing is refused on the SDK500 path",async()=>{
 await assert.rejects(authenticateWebhookSafely(request(body+" ",headers()),{authenticateWebhook:sdk500,apiSecret:secret,...silent}),e=>e instanceof Response&&e.status===401);
});
test("SDK500 with missing secret cannot become an authenticated request",async()=>{
 await assert.rejects(authenticateWebhookSafely(request(),{authenticateWebhook:sdk500,apiSecret:"",...silent}),e=>e instanceof Response&&e.status===401);
});
test("SDK non500 Responses and ordinary failures propagate unchanged",async()=>{
 for(const failure of [new Response(null,{status:400}),new Response(null,{status:401}),new Response(null,{status:405}),new Response(null,{status:503}),new Error("synthetic-network")]){
  let logs=0;
  await assert.rejects(authenticateWebhookSafely(request(),{authenticateWebhook:async r=>{await r.text();throw failure;},apiSecret:secret,log:()=>logs++}),e=>e===failure);
  assert.equal(logs,0);
 }
});
test("alternate Shopify headers preserve the verified payload on fallback",async()=>{
 const value=await authenticateWebhookSafely(request(body,headers(body,true)),{authenticateWebhook:sdk500,apiSecret:secret,...silent});
 assert.deepEqual(value.payload,JSON.parse(body));assert.equal(value.topic,"CUSTOMERS_REDACT");assert.equal(value.shop,"audit.myshopify.com");
});
