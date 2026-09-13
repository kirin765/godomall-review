/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./load-source.cjs');
const platform = 'godomall';
const review = { writer: 'buyer', score: 5, content: 'same review', createdAt: '2026-01-01', option: null, productName: null, images: [], sourceId: 'occurrence:0' };
function setup(remote, storage = true) {
 const claimed = new Set(); let calls = 0;
 const imports = {
  reviewHash: (_product, r) => JSON.stringify([r.content, r.sourceId]),
  claimImports: async (_shop, hashes) => { if (!storage) throw new Error('storage unavailable'); if (hashes.some(h => claimed.has(h))) return false; hashes.forEach(h => claimed.add(h)); return true; },
  releaseClaims: async (_shop, hashes) => hashes.forEach(h => claimed.delete(h)),
  recordImports: async () => { if (!storage) throw new Error('storage unavailable'); },
 };
 const api = platform === 'makeshop' ? { createReview: async () => { calls++; return remote(); } } : { importReviews: async () => { calls++; return remote(); } };
 const writer = loadSource('src/lib/writeReviews.ts', { '@/lib/imports': imports, ['@/lib/'+platform]: api });
 const write = rows => platform === 'makeshop' ? writer.writeReviews('token','shop','1',rows) : writer.writeReviews('token',1,1,'coupang',rows);
 return {write, calls: () => calls};
}
test('remote creation followed by a lost response cannot be reposted', async () => {
 const h=setup(() => { throw new Error('response lost after creation'); });
 await h.write([review]); await h.write([review]);
 assert.equal(h.calls(),1);
});
test('database failure prevents remote creation', async () => {
 const h=setup(() => platform === 'makeshop' ? undefined : {success:1,fail:0,failMessage:[]}, false);
 await h.write([review]).catch(() => {});
 assert.equal(h.calls(),0);
});
const { identifyReviews, normalizeReviews, MAX_BATCH } = loadSource('src/lib/transferInput.ts');
const { toDateTime, parseReviewFile } = loadSource('src/lib/reviewImport.ts');
const { transferReviews, IMPORT_BATCH } = loadSource('src/lib/transferClient.ts');
const { writeClaimedReviews } = loadSource('src/lib/writeClaimedReviews.ts');
const XLSX = require('xlsx');
const ok = count => new Response(JSON.stringify({ written: count, already: 0, failed: 0, retryableIndices: [] }));
test('date parsing preserves timestamps, converts offsets, and rejects impossible dates', () => {
 assert.equal(toDateTime('2026-09-01T04:45:12Z'), '2026-09-01 13:45:12');
 assert.equal(toDateTime('2026-02-30'), null);
 assert.equal(toDateTime('2026-09-01T25:00:00+09:00'), null);
});
test('spreadsheet metadata never replaces content and every image column is preserved', () => {
 const workbook = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ['리뷰등록일','리뷰내용','평점','작성자','이미지1','이미지2'],
  ['2026-01-01','exact text',4,'buyer','https://example.com/1.jpg','https://example.com/2.png'],
 ]),'Reviews');
 const parsed = parseReviewFile(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}));
 assert.equal(parsed.reviews[0].content,'exact text');
 assert.equal(parsed.reviews[0].images.length,2);
});
test('invalid fields are rejected rather than truncated or given invented ratings', () => {
 for (const changed of [{content:'x'.repeat(5001)},{score:0},{createdAt:'2026-02-30'},{images:Array.from({length:11},()=> 'https://x.test/a.jpg')}]) assert.throws(()=>normalizeReviews([{...review,...changed}]));
 assert.equal(MAX_BATCH,platform==='makeshop'?100:200);
});
test('occurrence identities preserve 25,000 identical rows and canonical date equivalents', () => {
 const rows=identifyReviews(Array.from({length:25000},()=>({...review})));
 assert.equal(new Set(rows.map(r=>r.sourceId)).size,25000);
 const dates=identifyReviews([{...review,createdAt:'2026-01-01'},{...review,createdAt:'2026-01-01T00:00:00+09:00'}]);
 assert.deepEqual(dates.map(r=>r.sourceId),['occurrence:0','occurrence:1']);
});
test('partial retries send only explicitly unwritten rows and preserve totals', async () => {
 const rows=identifyReviews(Array.from({length:IMPORT_BATCH},()=>({...review}))); const calls=[];
 const result=await transferReviews({reviews:rows,productNo:1,startOffset:0,shouldStop:()=>false,onProgress:()=>{},pause:async()=>{},fetcher:async (_url,init)=>{
  const sent=JSON.parse(init.body).reviews;calls.push(sent.length);
  return calls.length===1?new Response(JSON.stringify({written:IMPORT_BATCH-2,already:0,failed:2,permanentFailed:1,retryableIndices:[IMPORT_BATCH-1]})):ok(1);
 }});
 assert.deepEqual(calls,[IMPORT_BATCH,1]);assert.equal(result.written,IMPORT_BATCH-1);assert.equal(result.failed,1);assert.equal(result.completedThrough,0);
});
test('resume skips only the fully completed prefix and stop prevents the next dispatch', async()=>{
 const rows=identifyReviews(Array.from({length:IMPORT_BATCH*3},()=>({...review})));let stop=false,calls=0;
 const result=await transferReviews({reviews:rows,productNo:1,startOffset:IMPORT_BATCH,shouldStop:()=>stop,onProgress:()=>{stop=true;},fetcher:async()=>{calls++;return ok(IMPORT_BATCH);}});
 assert.equal(calls,1);assert.equal(result.completedThrough,IMPORT_BATCH*2);
});
test('lost responses and malformed counts stop automatic retries',async()=>{
 for(const fetcher of [async()=>{throw new Error('lost');},async()=>new Response('{}'),async()=>new Response(JSON.stringify({written:IMPORT_BATCH+1,already:0,failed:0}))]){
  let calls=0;const result=await transferReviews({reviews:identifyReviews(Array.from({length:IMPORT_BATCH},()=>({...review}))),productNo:1,startOffset:0,shouldStop:()=>false,onProgress:()=>{},pause:async()=>{},fetcher:async(...args)=>{calls++;return fetcher(...args);}});
  assert.equal(calls,1);assert.equal(result.completedThrough,0);assert.ok(result.error);
 }
});
test('write deadline prevents dispatch and reports only safe retry indices',async()=>{
 let calls=0;
 const result=await writeClaimedReviews({rows:[review],hashes:['h'],batchSize:1,deadline:Date.now()-1,claim:async()=>{calls++;return true;},release:async()=>{},save:async()=>{},send:async()=>{calls++;return 'complete';}});
 assert.equal(calls,0);assert.deepEqual(result.retryableIndices,[0]);
});
test('ledger persistence failure remains uncertain with no automatic repost',async()=>{
 let claimed=false,calls=0;
 const opts={rows:[review],hashes:['h'],batchSize:1,deadline:Date.now()+30000,claim:async()=>{if(claimed)return false;claimed=true;return true;},release:async()=>{claimed=false;},save:async()=>{throw new Error('DB unavailable');},send:async()=>{calls++;return 'complete';}};
 assert.equal((await writeClaimedReviews(opts)).uncertain,1);
 assert.equal((await writeClaimedReviews(opts)).uncertainCharged,0);
 assert.equal(calls,1);
});
test('429 is retryable but ambiguous server errors retain claims',async()=>{
 for(const status of [429,500]){
  let released=0;
  const result=await writeClaimedReviews({rows:[review],hashes:['h'],batchSize:1,deadline:Date.now()+30000,claim:async()=>true,release:async()=>{released++;},save:async()=>{},send:async()=>{throw Object.assign(new Error('remote'),{status});}});
  assert.equal(released,status===429?1:0);assert.equal(result.uncertain,status===500?1:0);
 }
});
if(platform==='godomall'){
 test('partial bulk response never guesses row success or resends unknown rows',async()=>{
  const h=setup(()=>({success:1,fail:1,failMessage:['one rejection']}));
  const rows=[review,{...review,content:'second'}];
  const first=await h.write(rows);assert.equal(first.written,0);assert.equal(first.uncertain,2);
  await h.write(rows);assert.equal(h.calls(),1);
 });
 test('attachment rejection keeps photos and never retries as text',async()=>{
  const h=setup(()=>({success:0,fail:1,failMessage:['attachment storage full']}));
  const outcome=await h.write([{...review,images:['https://example.com/a.jpg']}]);
  assert.equal(h.calls(),1);assert.equal(outcome.permanentFailed,1);assert.equal(outcome.photoDropped,0);
 });
}else{
 test('Makeshop payload preserves four photos, all five scores and the documented date field',async()=>{
  let payload;
  const writer=loadSource('src/lib/writeReviews.ts',{'@/lib/imports':{reviewHash:()=> 'hash',claimImports:async()=>true,releaseClaims:async()=>{},recordImports:async()=>{}},'@/lib/makeshop':{createReview:async(_t,_s,p)=>{payload=p;}}});
  const images=Array.from({length:4},(_,i)=>`https://example.com/${i}.jpg`);
  const result=await writer.writeReviews('token','shop','1',[{...review,images}]);
  assert.equal(result.written,1);assert.equal(payload.date,'2026-01-01 00:00:00');
  assert.deepEqual([payload.file_url,payload.file_url_2,payload.file_url_3,payload.file_url_4],images);
  assert.deepEqual([1,2,3,4,5].map(n=>payload['score_'+n]),['5','5','5','5','5']);
 });
 test('Makeshop response requires explicit success and honors rejection',async()=>{
  const previous=global.fetch;
  try{
   const api=loadSource('src/lib/makeshop.ts');
   for(const payload of [{},{return_code:'0000'},{return_code:'0000',datas:{result:false}}]){
    global.fetch=async()=>new Response(JSON.stringify(payload));
    await assert.rejects(api.createReview('token','shop',{}));
   }
   global.fetch=async()=>new Response(JSON.stringify({return_code:'0000',datas:{result:true}}));
   await api.createReview('token','shop',{});
  }finally{global.fetch=previous;}
 });
}
test('batch API rejects oversized input before storage or remote writes',async()=>{
 const route=loadSource('src/app/api/reviews/batch/route.ts',{
  '@/lib/launch':platform==='makeshop'?{sessionShop:async()=> 'shop'}:{sessionMall:async()=>({mallNo:1,accessToken:'token'})},
  '@/lib/token':{getValidToken:async()=>({access_token:'token'})},
  '@/lib/writeReviews':{toNewImport:()=>{throw new Error('must validate first');}},
 });
 const response=await route.POST(new Request('http://localhost/api/reviews/batch',{method:'POST',body:JSON.stringify({product_no:1,reviews:Array.from({length:MAX_BATCH+1},()=>review)})}));
 assert.equal(response.status,400);
});
if(platform==='godomall')test('paid-status storage outage never becomes a free-plan result',async()=>{
 const original=process.env.DATABASE_URL;process.env.DATABASE_URL='postgres://local/test';
 try{
  const entitlement=loadSource('src/lib/entitlement.ts',{postgres:()=>async()=>{throw new Error('temporary database outage');}});
  await assert.rejects(entitlement.getEntitlement(1,'token'),/이용권 상태/);
 }finally{if(original===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=original;}
});

test('confirmed paid plan from the server is retained in transfer progress',async()=>{
 const result=await transferReviews({reviews:[review],productNo:1,startOffset:0,shouldStop:()=>false,onProgress:()=>{},fetcher:async()=>new Response(JSON.stringify({written:1,already:0,failed:0,paid:true,freeRemaining:null}))});
 assert.equal(result.paid,true);assert.equal(result.freeRemaining,null);
});
