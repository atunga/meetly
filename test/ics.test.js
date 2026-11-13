import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bookingIcs,escapeIcsText,foldIcsLine} from '../src/ics.js';
import {openDatabase,writeSetting} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {createApp,reconcileSafely} from '../src/server.js';
const sample=()=>({id:'booking-id',google_event_id:'google-event',ical_uid:'google-event@example.com',title:'A meeting',name:'Guest',status:'confirmed',start:Date.parse('2027-01-04T09:00:00Z'),end:Date.parse('2027-01-04T09:30:00Z'),created_at:Date.parse('2027-01-01T12:00:00Z'),meet_url:'https://meet.google.com/abc-defg-hij',email:'private@example.com',notes:'Private notes excluded'});
const unfold=s=>s.replace(/\r\n[ \t]/g,'');
const unescapeText=s=>s.replace(/\\([nN,;\\])/g,(_,c)=>c==='n'||c==='N'?'\n':c);

test('ICS is a valid UTC personal calendar copy with stable Google UID and no invitations',()=>{
 const ics=bookingIcs(sample());assert.ok(ics.endsWith('\r\n'));assert.equal(ics.replace(/\r\n/g,'').includes('\n'),false);
 assert.match(ics,/BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);assert.ok(!ics.includes('METHOD:'));assert.match(ics,/UID:google-event@example.com\r\n/);
 assert.match(ics,/DTSTART:20270104T090000Z\r\n/);assert.match(ics,/DTEND:20270104T093000Z\r\n/);assert.match(ics,/DTSTAMP:20270101T120000Z\r\n/);
 assert.ok(!ics.includes('ATTENDEE'));assert.ok(!ics.includes('ORGANIZER'));assert.ok(!ics.includes('private@example.com'));assert.ok(!ics.includes('Private notes'));
 assert.equal(bookingIcs(sample()),ics);
});

test('ICS escapes CR/LF, commas, semicolons and slashes without property injection',()=>{
 const title='Name, detail; slash\\\r\nATTENDEE:mailto:injected@example.com\nEND:VEVENT';
 const ics=unfold(bookingIcs({...sample(),title}));const lines=ics.split('\r\n');
 assert.equal(lines.filter(l=>l==='END:VEVENT').length,1);assert.equal(lines.filter(l=>l.startsWith('ATTENDEE:')).length,0);
 const summary=lines.find(l=>l.startsWith('SUMMARY:')).slice(8);assert.equal(unescapeText(summary),title.replace(/\r\n/g,'\n')+' · Guest');
 assert.equal(escapeIcsText('x\rY\nZ\r\nW'),'x\\nY\\nZ\\nW');
});

test('ICS folding respects 75 octets and preserves multi-byte Unicode',()=>{
 const value='SUMMARY:'+('👩🏽‍💻 Café 東京 '.repeat(30));const folded=foldIcsLine(value);
 for(const line of folded.split('\r\n'))assert.ok(Buffer.byteLength(line,'utf8')<=75);
 assert.equal(unfold(folded),value);assert.ok(!folded.includes('\uFFFD'));
 const ics=bookingIcs({...sample(),title:'東京 👩🏽‍💻'.repeat(50)});for(const line of ics.split('\r\n'))assert.ok(Buffer.byteLength(line,'utf8')<=75);
});

test('ICS is absent for pending/cancelled/demo and rejects unsafe Meet URLs',()=>{
 for(const status of ['pending','cancelled','failed'])assert.equal(bookingIcs({...sample(),status}),null);
 for(const meet_url of [null,'https://evil.example/meeting','https://meet.google.com/a\r\nATTENDEE:evil','javascript:alert(1)'])assert.equal(bookingIcs({...sample(),meet_url}),null);
 assert.equal(bookingIcs({...sample(),start:NaN}),null);
});

test('Existing database gains optional ICS UID column without losing settings',t=>{
 const dir=mkdtempSync(join(tmpdir(),'meetly-ics-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'app.sqlite');
 let db=openDatabase(path);writeSetting(db,'host',{name:'Preserved',timezone:'UTC'});db.exec('ALTER TABLE bookings DROP COLUMN ical_uid');db.close();
 db=openDatabase(path);assert.ok(db.prepare('PRAGMA table_info(bookings)').all().some(c=>c.name==='ical_uid'));assert.match(db.prepare("SELECT value FROM settings WHERE key='host'").get().value,/Preserved/);db.close();
});

test('ICS is returned only for the booking request or secret status key; cancellation removes it',async t=>{
 const config=loadConfig({},['--demo']);config.demo=false;config.ownerGoogleEmail='host@example.com';const db=openDatabase(':memory:');
 writeSetting(db,'host',{name:'Test Host',bio:'',timezone:'UTC'});writeSetting(db,'scheduling',{noticeMinutes:0,horizonDays:365,bufferBeforeMinutes:0,bufferAfterMinutes:10,slotStepMinutes:15});writeSetting(db,'availability',Array.from({length:7},(_,weekday)=>({weekday,startMinute:0,endMinute:1440})));
 const google={account:()=>({email:'host@example.com',calendar_id:'primary'}),freeBusy:async()=>[],insert:async row=>({id:row.google_event_id,iCalUID:row.google_event_id+'@example.com',extendedProperties:{private:{meetlyBookingId:row.id}},hangoutLink:'https://meet.google.com/abc-defg-hij'}),remove:async()=>{}};
 const app=createApp(config,{db,google,noWorker:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));config.appUrl='http://127.0.0.1:'+app.server.address().port;t.after(async()=>{await new Promise(r=>app.server.close(r));db.close();});
 const call=(path,data)=>fetch(config.appUrl+path,data?{method:'POST',headers:{Origin:config.appUrl,'Content-Type':'application/json'},body:JSON.stringify(data)}:{});
 const input={slug:'quick-intro',name:'Guest',email:'guest@example.com',timezone:'UTC',start:new Date(Math.ceil((Date.now()+86400000)/3600000)*3600000).toISOString(),idempotencyKey:randomUUID()};
 const booked=await (await call('/api/public/bookings',input)).json();assert.match(booked.booking.ics,/BEGIN:VCALENDAR/);assert.match(booked.booking.ics,new RegExp('UID:'+app.booking.get(booked.booking.id).google_event_id+'@example.com'));
 assert.equal((await call('/api/public/bookings/status',{idempotencyKey:randomUUID()})).status,404);
 assert.equal((await call('/api/public/bookings/'+booked.booking.id+'/ics')).status,404);
 const status=await (await call('/api/public/bookings/status',{idempotencyKey:input.idempotencyKey})).json();assert.equal(status.booking.ics,booked.booking.ics);
 const profile=await (await call('/api/public/profile')).text();assert.ok(!profile.includes('BEGIN:VCALENDAR'));assert.ok(!profile.includes('guest@example.com'));
 await app.booking.cancel(booked.booking.id);const cancelled=await (await call('/api/public/bookings/status',{idempotencyKey:input.idempotencyKey})).json();assert.equal(cancelled.booking.ics,null);
});

test('Background reconciliation handles query errors without rejecting or logging guest details',async()=>{
 const saved=console.error,errors=[];console.error=(...args)=>errors.push(args);try{await reconcileSafely({reconcile:async()=>{throw new Error('private guest data must not be logged');}});}finally{console.error=saved;}
 assert.equal(errors.length,1);assert.ok(!JSON.stringify(errors).includes('private guest'));
});
