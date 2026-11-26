import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
let vite, parser, api;
before(async () => {
  vite = await createServer({configFile:false,appType:"custom",server:{middlewareMode:true,hmr:false},plugins:[{name:"readonly-db",enforce:"pre",resolveId(source){if(source.endsWith("/db.server"))return "\0empty-db";},load(id){if(id==="\0empty-db")return "export default {}";}}]});
  parser = await vite.ssrLoadModule("/app/utils/product-add-csv.ts");
  api = await vite.ssrLoadModule("/app/utils/outbound-request-products.server.ts");
});
after(async () => {await vite?.close();});
const variant=(n,sku)=>({id:"gid://shopify/ProductVariant/"+n,displayName:"商品"+n,title:"青 / M",product:{title:"商品"+n},sku,barcode:String(n),inventoryItem:{id:"gid://shopify/InventoryItem/"+n}});
const result=(nodes,next=false,cursor=null)=>Response.json({data:{productVariants:{nodes,pageInfo:{hasNextPage:next,endCursor:cursor}}}});
test("CSV keeps quoted commas, quotes, BOM and row numbers; invalid quantities are never coerced",()=>{
  const rows=parser.parseProductCsv('\uFEFFSKU,数量\r\n"S,1",2\r\n"S""2",\r\nN,0\r\nD,1.2\r\nE,1e2\r\nF,1000000');
  assert.deepEqual(rows.slice(0,2),[{rowNumber:2,sku:"S,1",quantity:2},{rowNumber:3,sku:'S"2',quantity:1}]);
  assert.ok(rows.slice(2).every(row=>row.error));
  assert.ok(parser.parseProductCsv("SKU,数量\nX,1\nX,2").every(row=>row.error.includes("重複")));
  assert.throws(()=>parser.parseProductCsv('SKU,数量\n"broken,1'),/引用符/);
  assert.throws(()=>parser.parseProductCsv("SKU,数量\n"),/空/);
  assert.throws(()=>parser.parseProductCsv("X".repeat(1024*1024+1)),/1MB/);
  assert.throws(()=>parser.parseProductCsv("あ".repeat(350000)),/1MB/);
  assert.throws(()=>parser.parseProductCsv(Array.from({length:3001},(_,i)=>"S"+i+",1").join("\n")),/3000/);
});
test("collection follows variant cursors beyond 250 products without product-level truncation",async()=>{
  let calls=0;
  const products=await api.collectionProducts({graphql:async(query,{variables})=>{
    assert.match(query,/productVariants/);assert.equal(variables.query,"collection:12");
    assert.equal(variables.after,calls?"page"+calls:null);
    const start=calls++*100;return result(Array.from({length:calls<3?100:51},(_,i)=>variant(start+i,"S"+(start+i))),calls<3,"page"+calls);
  }},"gid://shopify/Collection/12");
  assert.equal(products.length,251);assert.equal(calls,3);assert.equal(products[250].quantity,1);
  await assert.rejects(()=>api.collectionProducts({graphql:()=>{throw new Error("must not call");}},"other"),/選び直/);
});
test("CSV examines every result page and refuses ambiguous or missing SKUs",async()=>{
  let calls=0;
  const rows=await api.resolveProductCsv({graphql:async(_query,{variables})=>{
    assert.ok(variables.query.includes('sku:"S,1"'));calls++;
    return calls===1?result([variant(1,"S,1"),variant(2,"DUP")],true,"more"):result([variant(3,"DUP")]);
  }},'SKU,数量\n"S,1",3\nDUP,1\nMISSING,1\nBAD,0');
  assert.equal(calls,2);assert.equal(rows[0].product.quantity,3);assert.match(rows[1].error,/複数/);assert.match(rows[2].error,/見つかりません/);assert.ok(rows[3].error);
});
test("catalog lookup reports API failure and broken cursors instead of partial successful data",async()=>{
  await assert.rejects(()=>api.collectionProducts({graphql:async()=>result([variant(1,"X")],true,null)},"gid://shopify/Collection/1"),/続き/);
  await assert.rejects(()=>api.resolveProductCsv({graphql:async()=>Response.json({errors:[{message:"not available"}]})},"X,1"),/接続/);
});
