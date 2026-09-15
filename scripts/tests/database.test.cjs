/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const postgres=require('postgres');
const {loadSource}=require('./load-source.cjs');
const platform='godomall';
const url=process.env.TEST_DATABASE_URL;
if(url&&!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw new Error('Disposable local DB required');
test('platform transfer database integration',{skip:!url},async t=>{
 const pools=[];const schema='test_'+require('node:crypto').randomUUID().replaceAll('-','');
 const control=postgres(url,{onnotice:()=>{}});await control`create schema ${control(schema)}`;
 const factory=(connection,options={})=>{const pool=postgres(connection,{...options,onnotice:()=>{},connection:{...options.connection,search_path:schema}});pools.push(pool);return pool;};
 process.env.DATABASE_URL=url;
 t.after(async()=>{await Promise.all(pools.map(p=>p.end({timeout:1})));await control`drop schema ${control(schema)} cascade`;await control.end();});
 const seed=factory(url);
 const imports=loadSource('src/lib/imports.ts',{postgres:factory});
 const {identifyReviews}=loadSource('src/lib/transferInput.ts');
 const engine=loadSource('src/lib/writeClaimedReviews.ts');
 const engineMock={writeClaimedReviews:options=>engine.writeClaimedReviews({...options,delayMs:0})};
 const writerFor=api=>loadSource('src/lib/writeReviews.ts',{'@/lib/imports':imports,['@/lib/'+platform]:api,'./writeClaimedReviews':engineMock});
 const writer=writerFor({});
 const shop=platform==='makeshop'?'stress-shop':7001;
 const product=platform==='makeshop'?'1':1;
 const table=platform==='makeshop'?'makeshop_review_imported':'godo_review_imported';
 const shopcol=platform==='makeshop'?'shop_uid':'mall_no';
 const review={content:'review',writer:'user****',score:4,createdAt:'2026-09-01',option:null,productName:null,images:[]};
 const identities=rows=>rows.map(row=>{
  const legacy={...row,sourceId:undefined};
  return {legacyHash:imports.reviewHash(product,legacy),occurrence:Number(row.sourceId?.split(':')[1]??0),aliases:imports.reviewHashAliases(product,row),legacyAliases:imports.reviewHashAliases(product,legacy)};
 });
 const split=(mall,reviews)=>{const rows=reviews.map(r=>writer.toNewImport(product,r));return imports.splitByExisting(mall,product,rows.map(r=>imports.reviewHash(product,r)),identities(rows));};
 const quota=loadSource('src/lib/quota.ts',{postgres:factory,'./billing':{getSubscription:async()=>({status:'trial',expiredAt:'2099-01-01'}),daysLeft:()=>14,TRIAL_DAYS:14,PLAN:{name:'Plus',price:9900,termDays:30}}});
 await t.test('first reservation and concurrent requests cannot exceed free quota',async()=>{
  const mall=platform==='makeshop'?'quota-shop':7002;
  assert.deepEqual(await quota.reserveQuota(mall,10),{ok:true,used:10});
  const results=await Promise.all([quota.reserveQuota(mall,10),quota.reserveQuota(mall,10)]);
  assert.equal(results.filter(r=>r.ok).length,1);
 });
 await t.test('durable claims are exclusive, restart-safe and all-or-nothing',async()=>{
  const results=await Promise.all([imports.claimImports(shop,['claim-a']),imports.claimImports(shop,['claim-a'])]);assert.equal(results.filter(Boolean).length,1);
  const restarted=loadSource('src/lib/imports.ts',{postgres:factory});assert.equal(await restarted.claimImports(shop,['claim-a']),false);
  assert.equal(await imports.claimImports(shop,['claim-a','claim-b']),false);
  assert.equal(await imports.claimImports(shop,['claim-b']),true);
 });
 await t.test('legacy multiplicity is respected without dropping new identical occurrences',async()=>{
  const mall=platform==='makeshop'?'legacy-shop':7003;
  const reviews=identifyReviews(Array.from({length:3},()=>({...review})));
  const row=writer.toNewImport(product,{...review,sourceId:undefined});row.dedup_hash=imports.reviewHash(product,row);
  await imports.recordImports(mall,[row,row]);
  assert.deepEqual(await split(mall,reviews),{already:2,blocked:0,pendingIndices:[2]});
 });
 await t.test('legacy CRLF hashes remain deduplicated after normalization',async()=>{
  const mall=7008;
  const rows=identifyReviews([{...review,content:'legacy\r\nline'}]);
  const legacy=writer.toNewImport(product,{...review,content:'legacy\r\nline',sourceId:undefined});
  legacy.dedup_hash=imports.reviewHashAliases(product,legacy)[0];
  await imports.recordImports(mall,[legacy]);
  assert.deepEqual(await split(mall,rows),{already:1,blocked:0,pendingIndices:[]});
 });
 await t.test('paid status stays unlimited and expiration is observed without restarting',async()=>{
  if(platform==='makeshop'){
   let status='paid';
   const paidQuota=loadSource('src/lib/quota.ts',{postgres:factory,'./billing':{getSubscription:async()=>({status,expiredAt:'2099-01-01'}),daysLeft:()=>14,TRIAL_DAYS:14,PLAN:{name:'Plus',price:9900,termDays:30}}});
   const before=pools.length;
   for(let i=0;i<250;i++)assert.equal((await paidQuota.checkQuota('paid-shop',100)).allowed,100);
   assert.equal(pools.length,before,'paid requests do not read free-usage storage');
   status='expired';assert.equal((await paidQuota.checkQuota('paid-shop',100)).allowed,0);
  }else{
   const entitlement=loadSource('src/lib/entitlement.ts',{postgres:factory,'@/lib/payment':{fetchAppStatus:async()=>({kind:'ACTIVE',expireDateTime:'2099-01-01 00:00:00'}),parseWorkspaceDate:s=>new Date(s)}});
   await entitlement.clearEntitlement(7004);
   await seed`insert into app_entitlement(mall_id,app_status,expire_ts) values ('7004','ACTIVE',now()+interval '1 day')`;
   await seed`insert into app_subscriptions(mall_id,payment_type,price,until_ts) values ('7004','CHARGE',9900,now()+interval '1 day')`;
   const before=pools.length;
   for(let i=0;i<250;i++)assert.equal((await entitlement.getEntitlement(7004,'token')).paid,true);
   assert.equal(pools.length,before,'paid checks reuse the initialized DB pool');
   await seed`update app_subscriptions set until_ts=now()-interval '1 day' where mall_id='7004'`;
   assert.equal((await entitlement.getEntitlement(7004,'token')).paid,false);
  }
 });
 await t.test('25,000 reviews survive throttling, uncertain writes, lost client response and replay',async()=>{
  const reviews=identifyReviews(Array.from({length:25000},(_,i)=>({...review,content:'review '+(i%1000)})));
  let remoteCount=0,calls=0,throttled=0,remoteInterrupted=false,clientInterrupted=false;
  let activeRows=[],activeCursor=0,lostRows=[];
  const remote=async count=>{
   calls++;
   if(calls%97===0){throttled++;throw Object.assign(new Error('rate limited'),{status:429});}
   remoteCount+=count;
   const rows=activeRows.slice(activeCursor,activeCursor+count);activeCursor+=count;
   if(!remoteInterrupted&&remoteCount>=8000){remoteInterrupted=true;lostRows=rows;throw new Error('created but response lost');}
   return {success:count,fail:0,failMessage:[]};
  };
  const api=platform==='makeshop'?{createReview:async()=>{await remote(1);}}:{importReviews:async(_token,rows)=>remote(rows.length)};
  const liveWriter=writerFor(api);
  const mocks={
   '@/lib/imports':imports,'@/lib/writeReviews':liveWriter,
   '@/lib/launch':platform==='makeshop'?{sessionShop:async()=>shop}:{sessionMall:async()=>({mallNo:shop,accessToken:'token'})},
   '@/lib/token':{getValidToken:async()=>({access_token:'token'})},
   '@/lib/entitlement':{getEntitlement:async()=>({paid:true})},
   '@/lib/quota':{FREE_LIMIT:20,checkQuota:async(_shop,want)=>({allowed:want,paid:true,used:0}),reserveQuota:async()=>{throw new Error('paid must not reserve quota');},releaseQuota:async()=>{throw new Error('paid must not change quota');}},
  };
  const route=loadSource('src/app/api/reviews/batch/route.ts',mocks);
  const {transferReviews}=loadSource('src/lib/transferClient.ts');
  const fetcher=async(_url,init)=>{
   activeRows=JSON.parse(init.body).reviews;activeCursor=0;
   const response=await route.POST(new Request('http://localhost/api/reviews/batch',init));
   assert.equal(response.status,200);
   if(remoteCount>=16000&&!clientInterrupted){clientInterrupted=true;throw new Error('browser response lost after ledger commit');}
   return response;
  };
  let checkpoint=0;
  const run=()=>transferReviews({reviews,productNo:product,startOffset:checkpoint,shouldStop:()=>false,onProgress:p=>{checkpoint=p.completedThrough;},pause:async()=>{},fetcher});
  const first=await run();assert.ok(first.uncertain>0);assert.ok(lostRows.length>0);
  const before=remoteCount;assert.ok((await run()).uncertain>0);assert.equal(remoteCount,before);
  // Simulated support verification has exact captured request-to-creation evidence.
  await imports.recordImports(shop,lostRows.map(r=>{const row=writer.toNewImport(product,r);return {...row,dedup_hash:imports.reviewHash(product,row)};}));
  assert.ok((await run()).error,'lost browser response must stop');
  const final=await run();assert.equal(final.error,undefined);assert.equal(final.failed,0);assert.equal(final.completedThrough,25000);
  assert.equal(remoteCount,25000);
  const [count]=await seed`select count(*)::int as n from ${seed(table)} where ${seed(shopcol)}=${shop}`;assert.equal(count.n,25000);
  checkpoint=0;const replay=await run();assert.equal(replay.written,0);assert.equal(replay.already,25000);assert.equal(remoteCount,25000);
  console.log(JSON.stringify({platform,rows:25000,remoteCount,ledgerCount:count.n,throttled,interruptions:2}));
 });
 await t.test('verified deletion releases only owned claims and permits reimport',async()=>{
  const mall=platform==='makeshop'?'delete-shop':7005;
  const reviewRow=identifyReviews([{...review,content:'delete test'}])[0];
  const row=writer.toNewImport(product,reviewRow);row.dedup_hash=imports.reviewHash(product,row);
  await imports.claimImports(mall,[row.dedup_hash]);await imports.recordImports(mall,[row]);
  if(platform==='makeshop'){
   const [record]=await seed`select import_key from ${seed(table)} where shop_uid=${mall}`;
   await imports.removeImports(mall,[record.import_key]);
  }else{
   await seed`update ${seed(table)} set article_sno=77 where mall_no=${mall}`;
   assert.deepEqual(await imports.ownedArticleNos(mall,[77,88]),[77]);
   await imports.removeImports(mall,[77]);
  }
  assert.deepEqual((await split(mall,[reviewRow])).pendingIndices,[0]);assert.equal(await imports.claimImports(mall,[row.dedup_hash]),true);
 });
 if(platform==='godomall')await t.test('unconfirmed legacy bulk rows stay blocked',async()=>{
  const rows=identifyReviews([{...review,content:'legacy uncertain'}]);const row=writer.toNewImport(product,rows[0]);row.dedup_hash=imports.reviewHash(product,row);
  await imports.recordImports(7006,[row]);await seed`update ${seed(table)} set write_confirmed=false where mall_no=7006`;
  assert.deepEqual(await split(7006,rows),{already:0,blocked:1,pendingIndices:[]});
 });
 await t.test('article reconciliation excludes assigned IDs and ambiguous identical candidates',async()=>{
  const mall=7007;
  const rows=identifyReviews([{...review,content:'unique mapping'},{...review,content:'ambiguous mapping'},{...review,content:'ambiguous mapping'},{...review,content:'assigned mapping'}]);
  await imports.recordImports(mall,rows.map(r=>{const row=writer.toNewImport(product,r);return {...row,dedup_hash:imports.reviewHash(product,row)};}));
  await seed`update ${seed(table)} set article_sno=90 where mall_no=${mall} and content='assigned mapping'`;
  const reconciler=loadSource('src/lib/imports.ts',{postgres:factory,'@/lib/godomall':{listGoodsReviewArticles:async()=>({totalCount:3,contents:[
   {sno:91,goodsSno:1,writerName:'user****',content:'unique mapping',rating:4,registerDateTime:new Date().toISOString()},
   {sno:92,goodsSno:1,writerName:'user****',content:'ambiguous mapping',rating:4,registerDateTime:new Date().toISOString()},
   {sno:90,goodsSno:1,writerName:'user****',content:'assigned mapping',rating:4,registerDateTime:new Date().toISOString()},
  ]})}});
  await reconciler.reconcileImports('token',mall);
  const mapped=await seed`select content,article_sno from ${seed(table)} where mall_no=${mall} order by content`;
  assert.equal(Number(mapped.find(r=>r.content==='unique mapping').article_sno),91);
  assert.equal(mapped.filter(r=>r.content==='ambiguous mapping').every(r=>r.article_sno===null),true);
 });

});
