import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { loadConfig } from './config.js';
import { openDatabase, readSetting, writeSetting, transaction, takeRate } from './db.js';
import { HttpError, hash, token, passwordVerifier, parseCookies, sameOrigin, textValue } from './security.js';
import { isTimezone } from './time.js';
import { GoogleCalendar, GoogleError } from './google.js';
import { BookingService, publicBooking } from './booking.js';
const publicDir=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const eventJSON=row=>({...row,active:Boolean(row.active)});
export async function reconcileSafely(booking) {
  try { await booking.reconcile(); }
  catch(error) { console.error('Booking reconciliation failed:',error?.name||'Error',error?.code||'unknown'); }
}
function integer(value,min,max,field) {if(!Number.isInteger(value)||value<min||value>max)throw new HttpError(400,`${field} must be between ${min} and ${max}.`);return value;}
function validateConfig(input) {
  const host={name:textValue(input.host?.name,'your name',1,80),bio:textValue(input.host?.bio||'','bio',0,600),timezone:input.host?.timezone};
  if(!isTimezone(host.timezone))throw new HttpError(400,'Choose a valid host time zone.');
  const s=input.settings||{};
  const settings={noticeMinutes:integer(s.noticeMinutes,0,43200,'Minimum notice'),horizonDays:integer(s.horizonDays,1,365,'Booking window'),bufferBeforeMinutes:integer(s.bufferBeforeMinutes,0,120,'Buffer before'),bufferAfterMinutes:integer(s.bufferAfterMinutes,0,120,'Buffer after'),slotStepMinutes:integer(s.slotStepMinutes,5,120,'Slot interval')};
  if(!Array.isArray(input.availability)||input.availability.length>28)throw new HttpError(400,'Set at most 28 availability windows.');
  const availability=input.availability.map(w=>({weekday:integer(w.weekday,0,6,'Day'),startMinute:integer(w.startMinute,0,1439,'Start time'),endMinute:integer(w.endMinute,1,1440,'End time')}));
  for(const [i,w] of availability.entries()) {
    if(w.startMinute>=w.endMinute)throw new HttpError(400,'Availability must end after it starts. Split overnight hours into two days.');
    if(availability.some((v,j)=>j!==i&&v.weekday===w.weekday&&v.startMinute<w.endMinute&&v.endMinute>w.startMinute))throw new HttpError(400,'Availability windows cannot overlap.');
  }
  return {host,settings,availability};
}
function validateEvent(input) {
  const slug=textValue(input.slug,'link slug',1,80);
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw new HttpError(400,'Use lowercase letters, numbers and hyphens for the link.');
  const color=input.color||'#355cce';if(!/^#[a-f0-9]{6}$/i.test(color))throw new HttpError(400,'Choose a valid color.');
  return {slug,title:textValue(input.title,'meeting name',1,100),description:textValue(input.description||'','description',0,1000),durationMinutes:integer(input.durationMinutes,5,480,'Meeting duration'),color,active:input.active!==false};
}
export function createApp(config,options={}) {
  const db=options.db||openDatabase(config.dbPath,{name:config.hostName,timezone:config.hostTimezone}),google=options.google||new GoogleCalendar(db,config),booking=new BookingService(db,config,google),verify=passwordVerifier(config.password);
  const connected=google.account();
  if (!config.demo && connected?.email && connected.email.toLowerCase()!==config.ownerGoogleEmail) {
    if (!options.db) db.close();
    throw new Error('Connected Google account does not match HOST_EMAIL. Restore the previous HOST_EMAIL, disconnect Google in the dashboard, then configure the new host.');
  }
  const authRevision=createHmac('sha256',config.encryptionKey).update(config.password).digest('hex');
  const previousRevision=db.prepare("SELECT value FROM settings WHERE key='auth_revision'").get();
  if (!previousRevision || JSON.parse(previousRevision.value)!==authRevision) transaction(db,()=>{
    db.prepare('DELETE FROM admin_sessions').run();
    db.prepare('DELETE FROM oauth_states').run();
    writeSetting(db,'auth_revision',authRevision);
  });
  const secureCookie=config.secure?'; Secure':'';
  function send(res,status,data,headers={}) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
  function session(req,required=false) {
    const value=parseCookies(req.headers.cookie).meetly_session;
    const row=value?db.prepare('SELECT * FROM admin_sessions WHERE id_hash=? AND expires>?').get(hash(value),Date.now()):null;
    if(!row&&required)throw new HttpError(401,'Please sign in again.');return row;
  }
  function requireAdmin(req) {const s=session(req,true);if(!['GET','HEAD'].includes(req.method)) {sameOrigin(req,config);if(req.headers['x-csrf-token']!==s.csrf)throw new HttpError(403,'Refresh this page and try again.','csrf_mismatch');}return s;}
  function rate(req,group,max,window=60000) {
    // Leave TRUST_PROXY off unless your proxy strips client-supplied forwarding headers.
    const ip=config.trustProxy?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim():req.socket.remoteAddress;
    if(!takeRate(db,`${group}:${hash(ip||'unknown')}`,max,window))throw new HttpError(429,'Too many requests. Please wait a moment before trying again.','rate_limited');
  }
  async function body(req) {
    if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'Send JSON data.');
    let size=0,chunks=[];
    for await(const chunk of req) {size+=chunk.length;if(size>16384)throw new HttpError(413,'This request is too large.');chunks.push(chunk);}
    try {const value=JSON.parse(Buffer.concat(chunks).toString());if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();return value;} catch {throw new HttpError(400,'Invalid JSON request.');}
  }
  async function route(req,res) {
    const url=new URL(req.url,config.appUrl),path=url.pathname,method=req.method;
    if(path==='/healthz'&&method==='GET')return send(res,200,{ok:true,calendarConfigured:google.configured?.()||false});
    if(path==='/auth/google/callback'&&method==='GET') {
      const s=session(req,true);
      try {
        if(url.searchParams.has('error'))throw new HttpError(400,'Google access was not granted.');
        await google.completeOAuth(url.searchParams.get('state'),url.searchParams.get('code'),s.id_hash);
        res.writeHead(303,{Location:'/admin?google=connected','Cache-Control':'no-store'});res.end();return;
      }catch {res.writeHead(303,{Location:'/admin?google=error','Cache-Control':'no-store'});res.end();return;}
    }
    if(path==='/api/public/profile'&&method==='GET')return send(res,200,{host:readSetting(db,'host'),eventTypes:db.prepare('SELECT * FROM event_types WHERE active=1 ORDER BY durationMinutes').all().map(eventJSON),connected:config.demo||Boolean(google.account()),demo:config.demo});
    const eventMatch=path.match(/^\/api\/public\/event-types\/([a-z0-9-]+)$/);
    if(eventMatch&&method==='GET') {
      const eventType=db.prepare('SELECT * FROM event_types WHERE slug=? AND active=1').get(eventMatch[1]);
      if(!eventType)throw new HttpError(404,'This meeting is no longer available.');
      return send(res,200,{eventType:eventJSON(eventType),host:readSetting(db,'host'),connected:config.demo||Boolean(google.account()),demo:config.demo});
    }
    if(path==='/api/public/availability'&&method==='GET') {
      rate(req,'availability',60);
      const timezone=url.searchParams.get('timezone')||'UTC';
      const slots=await booking.availability(url.searchParams.get('slug'),url.searchParams.get('from'),Number(url.searchParams.get('days')||14),timezone);
      return send(res,200,{slots,timezone,serverTime:new Date().toISOString()});
    }
    if(path==='/api/public/bookings'&&method==='POST') {
      sameOrigin(req,config);rate(req,'book',12,600000);const input=await body(req);
      if(input.website)throw new HttpError(400,'Booking could not be submitted.');
      const existing=typeof input.idempotencyKey==='string' && db.prepare('SELECT id FROM bookings WHERE key_hash=?').get(hash(input.idempotencyKey));
      if(!existing) {
        if(!takeRate(db,'host:bookings',80,3600000))throw new HttpError(429,'This booking page is busy. Please try again later.');
        if(!takeRate(db,`email:${hash(String(input.email).toLowerCase())}`,5,86400000))throw new HttpError(429,'Too many booking attempts for this email today. Contact the host directly.');
      }
      const result=await booking.book(input);return send(res,result.status==='pending'?202:existing?200:201,{booking:publicBooking(result),demo:config.demo});
    }
    if(path==='/api/public/bookings/status'&&method==='POST') {sameOrigin(req,config);rate(req,'status',60);const input=await body(req);const row=booking.status(textValue(input.idempotencyKey,'request identifier',20,128));return send(res,200,{booking:publicBooking(row),demo:config.demo});}
    if(path==='/api/admin/session'&&method==='GET') {const s=session(req);return send(res,200,s?{authenticated:true,csrfToken:s.csrf}:{authenticated:false});}
    if(path==='/api/admin/login'&&method==='POST') {
      sameOrigin(req,config);rate(req,'login',8,900000);const input=await body(req);
      if(!verify(input.password))throw new HttpError(401,'The password is incorrect.');
      db.prepare('DELETE FROM admin_sessions WHERE expires<?').run(Date.now());
      const value=token(),csrf=token();
      db.prepare('INSERT INTO admin_sessions(id_hash,csrf,expires) VALUES(?,?,?)').run(hash(value),csrf,Date.now()+43200000);
      return send(res,200,{authenticated:true,csrfToken:csrf},{'Set-Cookie':`meetly_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secureCookie}`});
    }
    if(path.startsWith('/api/admin/')) {
      const s=requireAdmin(req);
      if(path==='/api/admin/logout'&&method==='POST') {db.prepare('DELETE FROM admin_sessions WHERE id_hash=?').run(s.id_hash);return send(res,200,{ok:true},{'Set-Cookie':`meetly_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie}`});}
      if(path==='/api/admin/config'&&method==='GET') {
        const a=google.account();return send(res,200,{host:readSetting(db,'host'),settings:readSetting(db,'scheduling'),availability:readSetting(db,'availability'),eventTypes:db.prepare('SELECT * FROM event_types ORDER BY durationMinutes').all().map(eventJSON),google:{connected:Boolean(a),configured:google.configured?.()||false,email:a?.email||null,calendarId:a?.calendar_id||'primary',conflictCalendarIds:a?JSON.parse(a.conflict_calendars):['primary']},demo:config.demo});
      }
      if(path==='/api/admin/config'&&method==='PUT') {const c=validateConfig(await body(req));transaction(db,()=>{writeSetting(db,'host',c.host);writeSetting(db,'scheduling',c.settings);writeSetting(db,'availability',c.availability);});return send(res,200,{ok:true});}
      if(path==='/api/admin/event-types'&&method==='POST') {
        if(db.prepare('SELECT COUNT(*) AS count FROM event_types').get().count>=50)throw new HttpError(400,'You can create up to 50 meeting types.');
        const e=validateEvent(await body(req)),id=randomUUID();db.prepare('INSERT INTO event_types(id,slug,title,description,durationMinutes,color,active) VALUES(?,?,?,?,?,?,?)').run(id,e.slug,e.title,e.description,e.durationMinutes,e.color,e.active?1:0);return send(res,201,{eventType:{id,...e}});
      }
      const edit=path.match(/^\/api\/admin\/event-types\/([\w-]+)$/);
      if(edit&&['PUT','DELETE'].includes(method)) {
        if(!db.prepare('SELECT id FROM event_types WHERE id=?').get(edit[1]))throw new HttpError(404,'Meeting type not found.');
        if(method==='DELETE') {db.prepare('DELETE FROM event_types WHERE id=?').run(edit[1]);return send(res,200,{ok:true});}
        const e=validateEvent(await body(req));db.prepare('UPDATE event_types SET slug=?,title=?,description=?,durationMinutes=?,color=?,active=? WHERE id=?').run(e.slug,e.title,e.description,e.durationMinutes,e.color,e.active?1:0,edit[1]);return send(res,200,{eventType:{id:edit[1],...e}});
      }
      if(path==='/api/admin/bookings'&&method==='GET')return send(res,200,{bookings:db.prepare('SELECT * FROM bookings ORDER BY start DESC LIMIT 200').all().map(publicBooking)});
      if(path==='/api/admin/reconcile'&&method==='POST') {await booking.reconcile();return send(res,200,{ok:true});}
      const cancel=path.match(/^\/api\/admin\/bookings\/([\w-]+)\/cancel$/);
      if(cancel&&method==='POST')return send(res,200,{booking:publicBooking(await booking.cancel(cancel[1]))});
      if(path==='/api/admin/google/connect'&&method==='POST') {if(config.demo)throw new HttpError(400,'Google connection is disabled in the local demo. Start the configured app to connect.');return send(res,200,{url:google.beginOAuth(s.id_hash)});}
      if(path==='/api/admin/google/disconnect'&&method==='POST') {
        const open=db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE status='pending' OR (status='confirmed' AND end>?)").get(Date.now()).count;
        if(open)throw new HttpError(409,'Cancel upcoming bookings and resolve pending bookings before disconnecting. This keeps existing calendar events manageable.');
        db.prepare('DELETE FROM google_account').run();return send(res,200,{ok:true});
      }
      if(path==='/api/admin/google/calendars'&&method==='GET')return send(res,200,{calendars:await google.calendars()});
      if(path==='/api/admin/google/calendars'&&method==='PUT') {
        const input=await body(req),calendarId=textValue(input.calendarId,'calendar',1,254),ids=input.conflictCalendarIds;
        if(!Array.isArray(ids)||ids.length<1||ids.length>50||ids.some(x=>typeof x!=='string'||x.length>254))throw new HttpError(400,'Select between 1 and 50 calendars to check for conflicts.');
        if(new Set([calendarId,...ids]).size>50)throw new HttpError(400,'Check at most 50 calendars including the destination.');
        const calendars=await google.calendars(),match=calendars.find(c=>c.id===calendarId||(calendarId==='primary'&&c.primary));
        if(!match||match.accessRole!=='owner'||!match.conferenceAllowed)throw new HttpError(400,'Choose a calendar you own that supports Google Meet.');
        if(ids.some(id=>!calendars.some(c=>c.id===id||(id==='primary'&&c.primary))))throw new HttpError(400,'Choose calendars you can access.');
        db.prepare('UPDATE google_account SET calendar_id=?,conflict_calendars=? WHERE id=1').run(calendarId,JSON.stringify([...new Set([calendarId,...ids])]));return send(res,200,{ok:true});
      }
      throw new HttpError(404,'Admin endpoint not found.');
    }
    if(path.startsWith('/api/'))throw new HttpError(404,'Endpoint not found.');
    if(method!=='GET'&&method!=='HEAD')throw new HttpError(405,'Method not allowed.');
    const asset=path==='/'||path==='/admin'||path==='/admin/'||/^\/book\/[a-z0-9-]+\/?$/.test(path)?'/index.html':path;
    if(!/^\/[a-zA-Z0-9_./-]+$/.test(asset) || asset.includes('..'))throw new HttpError(404,'Not found.');
    const file=join(publicDir,asset);
    let content;try {content=await readFile(file);}catch {throw new HttpError(404,'Not found.');}
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'}[extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:content);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(config.secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {await route(req,res);} catch(error) {
      if(res.headersSent)return res.end();
      let status=error.status||500,message=error instanceof HttpError?error.message:'Something went wrong. Please try again.',code=error.code||'server_error';
      if(error instanceof GoogleError) {status=503;message='Google Calendar is temporarily unavailable. Please try again later.';code='calendar_unavailable';}
      if(error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message)) {status=409;message='That booking link already exists. Choose another link.';}
      if(/database is locked/.test(error.message)) {status=503;message='The booking page is busy. Please try again.';code='database_busy';}
      if(status===500)console.error('Request failed:',error.name,error.code||'unknown');
      send(res,status,{error:message,code});
    }
  });
  server.requestTimeout=20000;server.headersTimeout=15000;
  let reconciling=false;
  const interval=options.noWorker?null:setInterval(async()=>{if(reconciling)return;reconciling=true;try{await reconcileSafely(booking);}finally{reconciling=false;}},30000);
  interval?.unref();
  server.on('close',()=>{if(interval)clearInterval(interval);});
  return {server,db,booking,google};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const config=loadConfig(),app=createApp(config);
    app.server.listen(config.port,config.bind,()=>console.log(`Meetly is listening at ${config.appUrl}${config.demo?' (local demo, no Google events are created)':''}`));
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.server.close(()=>{app.db.close();process.exit(0);}));
  }catch(error){console.error(error.message);process.exit(1);}
}
