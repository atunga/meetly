import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase,readSetting,writeSetting,takeRate } from '../src/db.js';
import { wallInstants,dateKey,makeCandidates,subtractBusy,overlaps } from '../src/time.js';
import { BookingService } from '../src/booking.js';
import { encrypt,decrypt,passwordVerifier } from '../src/security.js';
import { GoogleCalendar } from '../src/google.js';
import { createApp } from '../src/server.js';
const demoConfig=()=>loadConfig({},['--demo']);
function fixture({demo=true,google:custom}={}) {
  const db=openDatabase(':memory:'),config=demoConfig();config.demo=demo;
  writeSetting(db,'host',{name:'Test host',bio:'Hello',timezone:'UTC'});
  writeSetting(db,'scheduling',{noticeMinutes:0,horizonDays:365,bufferBeforeMinutes:0,bufferAfterMinutes:10,slotStepMinutes:15});
  writeSetting(db,'availability',[0,1,2,3,4,5,6].map(weekday=>({weekday,startMinute:0,endMinute:1440})));
  const events=new Map();
  const google=custom||{
    account:()=>({calendar_id:'primary'}),freeBusy:async()=>[],
    insert:async row=>{const e={id:row.google_event_id,extendedProperties:{private:{meetlyBookingId:row.id}},hangoutLink:'https://meet.google.com/abc-defg-hij',htmlLink:'https://calendar.google.com/calendar/event?eid=test',conferenceData:{createRequest:{status:{statusCode:'success'}}}};events.set(row.google_event_id,e);return e;},
    get:async row=>{if(events.has(row.google_event_id))return events.get(row.google_event_id);throw {status:404};},remove:async()=>{}
  };
  const service=new BookingService(db,config,google);
  const start=new Date(Math.ceil((Date.now()+3*86400000)/3600000)*3600000).toISOString();
  const input={slug:'conversation',name:'Jane Test',email:'jane@example.com',notes:'A note',timezone:'UTC',start,idempotencyKey:randomUUID()};
  return {db,config,service,input,google,events};
}
test('DST: nonexistent NY wall time is skipped; repeated time has two instants',()=>{
  assert.deepEqual(wallInstants('2027-03-14',150,'America/New_York'),[]);
  const repeated=wallInstants('2027-11-07',90,'America/New_York');
  assert.equal(repeated.length,2);assert.equal(repeated[1]-repeated[0],3600000);
  assert.equal(new Date(repeated[0]).toISOString(),'2027-11-07T05:30:00.000Z');
});
test('Half-hour / 45-minute zones and date boundary',()=>{
  assert.equal(new Date(wallInstants('2027-01-04',540,'Asia/Kolkata')[0]).toISOString(),'2027-01-04T03:30:00.000Z');
  assert.equal(new Date(wallInstants('2027-01-04',540,'Asia/Kathmandu')[0]).toISOString(),'2027-01-04T03:15:00.000Z');
  assert.equal(dateKey(Date.parse('2027-01-04T00:00:00Z'),'America/Los_Angeles'),'2027-01-03');
});
test('Availability: only working hours, minimum notice, buffers, bounded horizon',()=>{
  const c=makeCandidates({eventType:{durationMinutes:30},host:{timezone:'UTC'},settings:{noticeMinutes:60,horizonDays:7,bufferBeforeMinutes:0,bufferAfterMinutes:10,slotStepMinutes:15},availability:[{weekday:1,startMinute:540,endMinute:600}],from:'2027-01-04',days:1,timezone:'UTC',now:Date.parse('2027-01-04T08:15:00Z')});
  assert.deepEqual(c.map(s=>new Date(s.start).toISOString()),['2027-01-04T09:15:00.000Z','2027-01-04T09:30:00.000Z']);
  assert.equal(subtractBusy(c,[{start:Date.parse('2027-01-04T09:55:00Z'),end:Date.parse('2027-01-04T10:30:00Z')}]).length,1);
  assert.equal(overlaps(0,10,10,20),false);
});
test('Time zones align to guest-local day without shifting host hours',()=>{
  const c=makeCandidates({eventType:{durationMinutes:30},host:{timezone:'Pacific/Auckland'},settings:{noticeMinutes:0,horizonDays:30,bufferBeforeMinutes:0,bufferAfterMinutes:0,slotStepMinutes:30},availability:[{weekday:1,startMinute:540,endMinute:600}],from:'2027-01-03',days:1,timezone:'America/Los_Angeles',now:Date.parse('2027-01-01T00:00:00Z')});
  assert.equal(c.length,2);assert.equal(dateKey(c[0].start,'Pacific/Auckland'),'2027-01-04');assert.equal(dateKey(c[0].start,'America/Los_Angeles'),'2027-01-03');
});
test('Reject arbitrary, off-grid and invalid booking times',async()=>{
  const f=fixture(); await assert.rejects(f.service.book({...f.input,start:new Date(Date.parse(f.input.start)+60000).toISOString()}),/no longer available/);
  await assert.rejects(f.service.book({...f.input,timezone:'Bad/Zone'}),/valid time zone/);f.db.close();
});
test('Concurrent bookings across differing durations cannot overlap',async()=>{
  const f=fixture({demo:false});let release;f.google.freeBusy=()=>new Promise(r=>{release=()=>r([]);});
  const first=f.service.book(f.input);
  await assert.rejects(f.service.book({...f.input,slug:'quick-intro',start:new Date(Date.parse(f.input.start)+15*60000).toISOString(),idempotencyKey:randomUUID()}),/reserved/);
  release();const row=await first;assert.equal(row.status,'confirmed');assert.ok(row.meet_url);f.db.close();
});
test('Duplicate request returns same booking; altered payload rejected',async()=>{
  const f=fixture();const a=await f.service.book(f.input),b=await f.service.book(f.input);assert.equal(a.id,b.id);
  await assert.rejects(f.service.book({...f.input,name:'Changed'}),/different booking details/);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM bookings').get().count,1);f.db.close();
});
test('Fresh Google conflict prevents calendar insertion',async()=>{
  const f=fixture({demo:false});let inserted=false;f.google.freeBusy=async()=>[{start:Date.parse(f.input.start),end:Date.parse(f.input.start)+3600000}];f.google.insert=async()=>{inserted=true;};
  await assert.rejects(f.service.book(f.input),/could not be booked/);assert.equal(inserted,false);assert.equal(f.db.prepare('SELECT status FROM bookings').get().status,'failed');f.db.close();
});
test('Unknown insert outcome retains hold and reconciles existing stable event',async()=>{
  const f=fixture({demo:false});const original=f.google.insert;let inserts=0;f.google.insert=async row=>{inserts++;await original(row);throw {status:0};};
  const pending=await f.service.book(f.input);assert.equal(pending.status,'pending');assert.equal(pending.needs_review,1);
  await assert.rejects(f.service.book({...f.input,idempotencyKey:randomUUID()}),/reserved/);
  f.db.prepare('UPDATE bookings SET attempt_at=?').run(Date.now()-100000);
  await f.service.process(pending.id);assert.equal(f.service.get(pending.id).status,'confirmed');assert.equal(inserts,1);f.db.close();
});
test('FreeBusy failure before insertion releases its known no-write reservation',async()=>{
  const f=fixture({demo:false});let inserts=0;f.google.freeBusy=async()=>{throw {status:503};};f.google.insert=async()=>{inserts++;};
  await assert.rejects(f.service.book(f.input),/could not be booked/);assert.equal(inserts,0);assert.equal(f.db.prepare('SELECT status FROM bookings').get().status,'failed');f.db.close();
});
test('Meet pending is not fabricated as a URL',async()=>{
  const f=fixture({demo:false});f.google.insert=async row=>({id:row.google_event_id,extendedProperties:{private:{meetlyBookingId:row.id}},conferenceData:{createRequest:{status:{statusCode:'pending'}}}});
  const row=await f.service.book(f.input);assert.equal(row.status,'confirmed');assert.equal(row.meet_url,null);assert.equal(row.conference_status,'pending');f.db.close();
});
test('Persistent database restores bookings and does not restore deleted event types',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'meetly-test-'));let db=openDatabase(join(dir,'db.sqlite'));db.prepare('DELETE FROM event_types WHERE id=?').run('intro');writeSetting(db,'host',{name:'Saved',timezone:'UTC'});db.close();db=openDatabase(join(dir,'db.sqlite'));assert.equal(readSetting(db,'host').name,'Saved');assert.equal(db.prepare('SELECT id FROM event_types WHERE id=?').get('intro'),undefined);db.close();rmSync(dir,{recursive:true});
});
test('Token encryption authenticates ciphertext; password verifier works',()=>{
  const key=Buffer.alloc(32,1),value=encrypt('test-refresh',key);assert.equal(decrypt(value,key),'test-refresh');assert.throws(()=>decrypt(value,Buffer.alloc(32,2)));const verify=passwordVerifier('long-password12345');assert.equal(verify('long-password12345'),true);assert.equal(verify('wrong'),false);
});
test('Rate limits persist and expire',()=>{const db=openDatabase(':memory:');assert.equal(takeRate(db,'x',1,100,10),true);assert.equal(takeRate(db,'x',1,100,20),false);assert.equal(takeRate(db,'x',1,100,111),true);db.close();});
test('Production config requires strong secrets and HTTPS',()=>{
  assert.throws(()=>loadConfig({},[]),/ADMIN_PASSWORD/);assert.throws(()=>loadConfig({APP_URL:'http://example.com'},[]),/HTTPS/);
  assert.throws(()=>loadConfig({NODE_ENV:'production'},['--demo']),/local-only/);
});
test('FreeBusy HTTP success with calendar errors fails closed',async()=>{
  const f=fixture();const g=new GoogleCalendar(f.db,f.config);g.account=()=>({calendar_id:'primary',conflict_calendars:'["primary"]'});g.api=async()=>({calendars:{primary:{errors:[{reason:'notFound'}]}}});await assert.rejects(g.freeBusy(0,1000),e=>e.code==='freebusy_incomplete');f.db.close();
});
test('HTTP auth, CSRF, validation, demo booking and hidden admin data',async()=>{
  const config=demoConfig();config.port=0;const app=createApp(config,{noWorker:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${app.server.address().port}`;
  const call=(path,method='GET',data,headers={})=>fetch(url+path,{method,headers:{Origin:config.appUrl,...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
  try {
    assert.equal((await call('/api/admin/config')).status,401);
    assert.equal((await call('/api/admin/login','POST',{password:config.password},{Origin:'https://evil.test'})).status,403);
    const login=await call('/api/admin/login','POST',{password:config.password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],{csrfToken}=await login.json();
    const configResponse=await call('/api/admin/config','GET',null,{Cookie:cookie});assert.equal(configResponse.status,200);const state=await configResponse.json();
    assert.equal((await call('/api/admin/config','PUT',state,{Cookie:cookie})).status,403);
    assert.equal((await call('/api/admin/config','PUT',state,{Cookie:cookie,'X-CSRF-Token':csrfToken})).status,200);
    const profile=await (await call('/api/public/profile')).json();assert.equal(profile.demo,true);assert.equal(profile.eventTypes.length,3);assert.ok(!JSON.stringify(profile).includes(config.password));
    assert.equal((await call('/api/admin/google/connect','POST',{}, {Cookie:cookie,'X-CSRF-Token':csrfToken})).status,400);
    const availability=await (await call(`/api/public/availability?slug=conversation&timezone=UTC&days=7&from=${new Date().toISOString().slice(0,10)}`)).json();assert.ok(availability.slots.length);
    const input={slug:'conversation',start:availability.slots[0].start,name:'Tester',email:'tester@example.com',timezone:'UTC',idempotencyKey:randomUUID()};
    const booked=await call('/api/public/bookings','POST',input);assert.equal(booked.status,201);const result=await booked.json();assert.equal(result.booking.status,'confirmed');assert.equal(result.booking.meetUrl,null);assert.equal(result.demo,true);
    const replay=await call('/api/public/bookings','POST',input);assert.equal(replay.status,200);
    assert.equal((await call('/api/public/bookings/status','POST',{idempotencyKey:input.idempotencyKey})).status,200);
    assert.equal((await call('/api/admin/bookings/'+result.booking.id+'/cancel','POST',{}, {Cookie:cookie,'X-CSRF-Token':csrfToken})).status,200);
    assert.equal((await call('/api/admin/logout','POST',{}, {Cookie:cookie,'X-CSRF-Token':csrfToken})).status,200);
    assert.equal((await call('/api/admin/config','GET',null,{Cookie:cookie})).status,401);
  } finally {await new Promise(r=>app.server.close(r));app.db.close();}
});
test('Live mode fails closed with no connected calendar',async()=>{
  const f=fixture({demo:false});f.google.account=()=>null;
  await assert.rejects(f.service.availability('conversation',f.input.start.slice(0,10),1,'UTC'),e=>e.status===503);
  await assert.rejects(f.service.book(f.input),e=>e.status===503);f.db.close();
});
test('Server enforces event edit validation and serves assets with protection headers',async()=>{
  const config=demoConfig();const app=createApp(config,{noWorker:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${app.server.address().port}`;
  const call=(path,method='GET',data,headers={})=>fetch(url+path,{method,headers:{Origin:config.appUrl,...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
  try {
    for (const path of ['/','/book/conversation','/admin','/app.js','/style.css','/favicon.svg']) {const r=await call(path);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);}
    const login=await call('/api/admin/login','POST',{password:config.password}),cookie=login.headers.get('set-cookie').split(';')[0],{csrfToken}=await login.json();const headers={Cookie:cookie,'X-CSRF-Token':csrfToken};
    assert.equal((await call('/api/admin/event-types','POST',{slug:'Invalid Slug',title:'Bad',durationMinutes:30},headers)).status,400);
    const event={slug:'test-45',title:'A focused meeting',description:'Test',durationMinutes:45,color:'#123456',active:true};
    const created=await call('/api/admin/event-types','POST',event,headers);assert.equal(created.status,201);const {eventType}=await created.json();
    assert.equal((await call('/api/public/event-types/test-45')).status,200);
    assert.equal((await call('/api/admin/event-types/'+eventType.id,'PUT',{...event,active:false},headers)).status,200);
    assert.equal((await call('/api/public/event-types/test-45')).status,404);
    assert.equal((await call('/api/admin/event-types/'+eventType.id,'DELETE',null,headers)).status,200);
    assert.equal((await call('/api/admin/config','PUT',{host:{name:'Test',bio:'',timezone:'Bad/Zone'},settings:{},availability:[]},headers)).status,400);
    assert.equal((await call('/api/public/bookings','POST',{notes:'x'.repeat(17000)})).status,413);
  }finally{await new Promise(r=>app.server.close(r));app.db.close();}
});
test('Pending booking survives restart and remains reserved',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'meetly-restart-')),path=join(directory,'db.sqlite');const f=fixture({demo:false});
  const db=openDatabase(path);writeSetting(db,'host',readSetting(f.db,'host'));writeSetting(db,'scheduling',readSetting(f.db,'scheduling'));writeSetting(db,'availability',readSetting(f.db,'availability'));f.db.close();
  const google={account:()=>({calendar_id:'primary'}),freeBusy:async()=>[],insert:async()=>{throw {status:0};}};
  let service=new BookingService(db,f.config,google);const row=await service.book(f.input);assert.equal(row.status,'pending');db.close();
  const restored=openDatabase(path);service=new BookingService(restored,f.config,google);assert.equal(service.get(row.id).status,'pending');await assert.rejects(service.book({...f.input,idempotencyKey:randomUUID()}),/reserved/);restored.close();rmSync(directory,{recursive:true});
});
test('OAuth state is session-bound, uses PKCE and stores encrypted refresh tokens',async()=>{
  const config=demoConfig();config.googleClientId='test-client';config.googleClientSecret='test-secret';const db=openDatabase(':memory:');
  const responses=[{access_token:'mock-access',refresh_token:'mock-refresh',scope:'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly'},{sub:'google-sub',email:'host@example.com',email_verified:true}];
  const calls=[];const google=new GoogleCalendar(db,config,async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(responses.shift()),{status:200,headers:{'content-type':'application/json'}});});
  const link=new URL(google.beginOAuth('session-one'));assert.equal(link.searchParams.get('access_type'),'offline');assert.equal(link.searchParams.get('code_challenge_method'),'S256');
  await assert.rejects(google.completeOAuth(link.searchParams.get('state'),'code','different-session'),/expired/);assert.equal(calls.length,0);
  await google.completeOAuth(link.searchParams.get('state'),'code','session-one');
  assert.equal(google.account().email,'host@example.com');assert.notEqual(google.account().refresh_token,'mock-refresh');assert.equal(decrypt(google.account().refresh_token,config.encryptionKey),'mock-refresh');
  assert.equal(calls[0].options.body.get('redirect_uri'),config.appUrl+'/auth/google/callback');assert.ok(calls[0].options.body.get('code_verifier'));
  await assert.rejects(google.completeOAuth(link.searchParams.get('state'),'code','session-one'),/expired/);db.close();
});
test('Calendar insertion uses stable ID, attendee invite and new Meet request',async()=>{
  const f=fixture(),google=new GoogleCalendar(f.db,f.config);let request;google.api=async(path,options)=>{request={path,body:JSON.parse(options.body)};return {};};
  await google.insert({google_event_id:'abc123',calendar_id:'primary',id:'booking-1',title:'Conversation',name:'Jane',email:'jane@example.com',timezone:'Europe/London',host_timezone:'UTC',start:Date.now(),end:Date.now()+1800000,notes:'Hello'});
  assert.match(request.path,/conferenceDataVersion=1&sendUpdates=all/);assert.equal(request.body.id,'abc123');assert.equal(request.body.attendees[0].displayName,'Jane');assert.equal(request.body.conferenceData.createRequest.requestId,'abc123');assert.equal(request.body.conferenceData.createRequest.conferenceSolutionKey.type,'hangoutsMeet');f.db.close();
});
test('Changing the admin password invalidates persisted sessions on startup',()=>{
  const config=demoConfig(),db=openDatabase(':memory:');const app=createApp(config,{db,noWorker:true});db.prepare('INSERT INTO admin_sessions(id_hash,csrf,expires) VALUES(?,?,?)').run('test-session','csrf',Date.now()+10000);
  const same=createApp(config,{db,noWorker:true});assert.equal(db.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count,1);
  const changed=createApp({...config,password:'different-long-password'},{db,noWorker:true});assert.equal(db.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count,0);app.server.close();same.server.close();changed.server.close();db.close();
});

test('Reconciler prioritizes least recently attempted pending bookings',async()=>{
  const f=fixture(),rows=[];
  for(let i=0;i<3;i++){
    const row=await f.service.book({...f.input,start:new Date(Date.parse(f.input.start)+i*2*3600000).toISOString(),idempotencyKey:randomUUID()});
    f.db.prepare("UPDATE bookings SET status='pending',created_at=?,attempt_at=? WHERE id=?").run((i+1)*10,(3-i)*10,row.id);rows.push(row);
  }
  const order=[];f.service.process=async id=>{order.push(id);};await f.service.reconcile();assert.deepEqual(order,rows.map(r=>r.id).reverse());f.db.close();
});
