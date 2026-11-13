import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.js';
import {openDatabase,readSetting,writeSetting} from '../src/db.js';
import {createApp} from '../src/server.js';
import {GoogleCalendar,GOOGLE_SCOPES} from '../src/google.js';

const env=()=>({ADMIN_PASSWORD:'local-test-password-not-for-deployment',TOKEN_ENCRYPTION_KEY:'ab'.repeat(32),HOST_NAME:'Example Host',HOST_EMAIL:'HOST@example.com',HOST_TIMEZONE:'Europe/London',APP_URL:'https://meet.example.com'});
function fixture(t){const db=openDatabase(':memory:');t.after(()=>db.close());const config=loadConfig(env(),[]);config.googleClientId='test-client';config.googleClientSecret='test-secret';return {db,config,g:new GoogleCalendar(db,config)};}
function successfulOAuth(g,user={sub:'host-sub',email:'host@example.com',email_verified:true}){let calls=0;g.request=async()=>++calls===1?{access_token:'test-access',refresh_token:'test-refresh',scope:GOOGLE_SCOPES.join(' ')}:user;return ()=>calls;}

test('Every real installation requires its own host name and Google email',()=>{
 const e=env();assert.equal(loadConfig(e,[]).ownerGoogleEmail,'host@example.com');
 assert.throws(()=>loadConfig({...e,HOST_NAME:''},[]),/HOST_NAME/);
 assert.throws(()=>loadConfig({...e,HOST_EMAIL:''},[]),/HOST_EMAIL/);
 assert.throws(()=>loadConfig({...e,HOST_EMAIL:'invalid'},[]),/HOST_EMAIL/);
 assert.throws(()=>loadConfig({...e,HOST_TIMEZONE:'invalid'},[]),/HOST_TIMEZONE/);
 assert.throws(()=>loadConfig({...e,OWNER_GOOGLE_EMAIL:'different@example.com'},[]),/must match/);
 const legacy=loadConfig({...e,HOST_EMAIL:'',OWNER_GOOGLE_EMAIL:'host@example.com'},[]);assert.equal(legacy.ownerGoogleEmail,'host@example.com');
 assert.equal(loadConfig({...e,HOST_TIMEZONE:''},[]).hostTimezone,'UTC');
});

test('Demo uses neutral identity and refuses public binding or reused live password',()=>{
 const c=loadConfig({},['--demo']);assert.equal(c.hostName,'Demo Host');assert.equal(c.ownerGoogleEmail,'host@example.com');assert.equal(c.hostTimezone,'UTC');
 assert.throws(()=>loadConfig({HOST:'0.0.0.0'},['--demo']),/loopback/);
 assert.throws(()=>loadConfig({...env(),ADMIN_PASSWORD:'meetly-demo-only'},[]),/demo password/);
 assert.throws(()=>loadConfig({...env(),APP_URL:'ftp://localhost'},[]),/HTTP/);
 assert.equal(loadConfig({...env(),APP_URL:'http://localhost:3000'},[]).bind,'127.0.0.1');
 assert.equal(loadConfig({...env(),APP_URL:'http://localhost:3000',HOST:'0.0.0.0'},[]).bind,'0.0.0.0');
 assert.throws(()=>loadConfig({...env(),ADMIN_PASSWORD:'a'.repeat(513)},[]),/ADMIN_PASSWORD/);
});

test('Host settings seed a new database once; later edits survive restarts',t=>{
 const dir=mkdtempSync(join(tmpdir(),'meetly-portable-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const config=loadConfig({...env(),DB_PATH:join(dir,'app.sqlite')},[]);let app=createApp(config,{noWorker:true});
 assert.deepEqual(readSetting(app.db,'host'),{name:'Example Host',bio:'Good conversations start with a little time. Choose a meeting below and find a moment that works for you.',timezone:'Europe/London'});
 assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,0);assert.equal(app.google.account(),undefined);
 writeSetting(app.db,'host',{name:'Edited Host',bio:'Edited',timezone:'Asia/Kolkata'});app.db.close();
 app=createApp({...config,hostName:'Ignored restart value',hostTimezone:'UTC'},{noWorker:true});
 assert.equal(readSetting(app.db,'host').name,'Edited Host');assert.equal(readSetting(app.db,'host').timezone,'Asia/Kolkata');app.db.close();
});

test('Fresh installations keep independent hosts, accounts, and data',t=>{
 const a=openDatabase(':memory:',{name:'Host A',timezone:'UTC'}),b=openDatabase(':memory:',{name:'Host B',timezone:'Europe/Paris'});t.after(()=>{a.close();b.close();});
 writeSetting(a,'private-test',{value:'only A'});assert.equal(b.prepare("SELECT * FROM settings WHERE key='private-test'").get(),undefined);
 assert.equal(readSetting(a,'host').name,'Host A');assert.equal(readSetting(b,'host').name,'Host B');
 assert.equal(a.prepare('SELECT COUNT(*) n FROM google_account').get().n,0);assert.equal(b.prepare('SELECT COUNT(*) n FROM google_account').get().n,0);
});

test('Restored database cannot silently serve a different configured Google host',t=>{
 const {db,config}=fixture(t);db.prepare('INSERT INTO google_account VALUES(1,?,?,?,?,?)').run('old-sub','other@example.com','test-encrypted-placeholder','primary','["primary"]');
 assert.throws(()=>createApp(config,{db,noWorker:true}),/does not match HOST_EMAIL/);
});

test('Google OAuth rejects a different account even if verified',async t=>{
 const {db,g}=fixture(t);const url=new URL(g.beginOAuth('session'));successfulOAuth(g,{sub:'other',email:'other@example.com',email_verified:true});
 await assert.rejects(g.completeOAuth(url.searchParams.get('state'),'code','session'),/not allowed/);assert.equal(db.prepare('SELECT COUNT(*) n FROM google_account').get().n,0);
});

test('Google verified flag must be boolean true, not a truthy string',async t=>{
 const {g}=fixture(t);const url=new URL(g.beginOAuth('session'));successfulOAuth(g,{sub:'host-sub',email:'host@example.com',email_verified:'true'});
 await assert.rejects(g.completeOAuth(url.searchParams.get('state'),'code','session'),/verified Google/);
});

test('OAuth state is consumed once and missing code cannot burn a valid state',async t=>{
 const {g}=fixture(t),url=new URL(g.beginOAuth('session')),state=url.searchParams.get('state');const calls=successfulOAuth(g);
 await assert.rejects(g.completeOAuth(state,null,'session'),/Invalid Google/);await g.completeOAuth(state,'code','session');assert.equal(calls(),2);
 await assert.rejects(g.completeOAuth(state,'code','session'),/expired/);assert.equal(calls(),2);
});

test('A missing Google access token fails before userinfo and account storage',async t=>{
 const {db,g}=fixture(t),url=new URL(g.beginOAuth('session'));let calls=0;g.request=async()=>{calls++;return {};};
 await assert.rejects(g.completeOAuth(url.searchParams.get('state'),'code','session'),e=>e.code==='missing_access_token');assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM google_account').get().n,0);
});

test('FreeBusy batches more than50 calendars including a snapshotted destination',async t=>{
 const {g}=fixture(t),ids=Array.from({length:50},(_,i)=>'calendar'+i),batches=[];g.account=()=>({calendar_id:ids[0],conflict_calendars:JSON.stringify(ids)});
 g.api=async(_path,options)=>{const request=JSON.parse(options.body);batches.push(request.items);assert.equal(request.calendarExpansionMax,50);return {calendars:Object.fromEntries(request.items.map(({id})=>[id,{busy:[]}]))};};
 assert.deepEqual(await g.freeBusy(0,1000,['original-calendar']),[]);assert.deepEqual(batches.map(b=>b.length),[50,1]);assert.equal(batches[1][0].id,'original-calendar');
});

test('Portable HTTP auth protects setup and keeps the host email out of public responses',async t=>{
 const config=loadConfig({...env(),APP_URL:'http://127.0.0.1:3000'},[]),db=openDatabase(':memory:',{name:config.hostName,timezone:config.hostTimezone});
 const app=createApp(config,{db,noWorker:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));config.appUrl='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));db.close();});
 const call=(path,options={})=>fetch(config.appUrl+path,{...options,headers:{Origin:config.appUrl,'Content-Type':'application/json',...options.headers}});
 const profile=await (await call('/api/public/profile')).json();assert.equal(profile.host.name,'Example Host');assert.equal(profile.connected,false);assert.equal(profile.demo,false);assert.ok(!JSON.stringify(profile).includes('host@example.com'));
 assert.equal((await call('/api/admin/config')).status,401);
 assert.equal((await call('/api/admin/config',{headers:{'oai-authenticated-user-id':'spoof','oai-authenticated-user-email':'host@example.com'}})).status,401);
 assert.equal((await call('/api/admin/reconcile',{method:'POST',body:'{}'})).status,401);
 const login=await call('/api/admin/login',{method:'POST',body:JSON.stringify({password:config.password})});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();
 assert.equal((await call('/api/admin/reconcile',{method:'POST',headers:{Cookie:cookie},body:'{}'})).status,403);
 assert.equal((await call('/api/admin/reconcile',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:'{}'})).status,200);
 assert.equal((await call('/api/admin/google/connect',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:'{}'})).status,503);
});
