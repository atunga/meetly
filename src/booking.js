import { randomUUID } from 'node:crypto';
import { HttpError, hash, textValue, validEmail } from './security.js';
import { readSetting, transaction } from './db.js';
import { makeCandidates, subtractBusy, overlaps, dateKey, isTimezone } from './time.js';
import { bookingIcs } from './ics.js';
export const getEventType=(db,slug)=>db.prepare('SELECT * FROM event_types WHERE slug=? AND active=1').get(slug);
export function publicBooking(row) {
  return {id:row.id,title:row.title,name:row.name,email:row.email,start:new Date(row.start).toISOString(),end:new Date(row.end).toISOString(),timezone:row.timezone,status:row.status,meetUrl:row.meet_url||null,calendarUrl:row.calendar_url||null,conferenceStatus:row.conference_status||null,needsReview:Boolean(row.needs_review),ics:bookingIcs(row)};
}
export class BookingService {
  constructor(db,config,google) {this.db=db;this.config=config;this.google=google;this.running=new Set();}
  get(id) {return this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id);}
  localBusy(from,to) {return this.db.prepare("SELECT block_start AS start,block_end AS end FROM bookings WHERE status IN ('pending','confirmed') AND block_start < ? AND block_end > ?").all(to,from);}
  candidates(slug,from,days,timezone,now=Date.now()) {
    const eventType=getEventType(this.db,slug); if(!eventType)throw new HttpError(404,'That meeting is not available.');
    return makeCandidates({eventType,host:readSetting(this.db,'host'),settings:readSetting(this.db,'scheduling'),availability:readSetting(this.db,'availability'),from,days,timezone,now});
  }
  async availability(slug,from,days,timezone) {
    if(!this.config.demo && !this.google.account())throw new HttpError(503,'The host is still setting up their calendar. Please check back soon.','calendar_unavailable');
    const candidates=this.candidates(slug,from,days,timezone);
    if(!candidates.length)return [];
    const start=candidates[0].blockStart, end=candidates.at(-1).blockEnd;
    const googleBusy=this.config.demo ? [] : await this.google.freeBusy(start,end);
    return subtractBusy(candidates,[...googleBusy,...this.localBusy(start,end)]).map(s=>({start:new Date(s.start).toISOString(),end:new Date(s.end).toISOString()}));
  }
  async book(input) {
    const slug=textValue(input.slug,'meeting',1,80), name=textValue(input.name,'name',1,100), email=validEmail(input.email),notes=textValue(input.notes||'','notes',0,2000);
    const timezone=input.timezone;
    if(!isTimezone(timezone))throw new HttpError(400,'Choose a valid time zone.');
    const key=textValue(input.idempotencyKey,'request identifier',20,128);
    if(!/^[\w-]+$/.test(key))throw new HttpError(400,'Invalid request identifier.');
    const start=Date.parse(input.start);
    if(!Number.isFinite(start)||start%60000!==0)throw new HttpError(400,'Choose one of the available times.');
    const fingerprint=hash(JSON.stringify({slug,name,email,notes,timezone,start}));
    let row=this.db.prepare('SELECT * FROM bookings WHERE key_hash=?').get(hash(key));
    if(row) {
      if(row.request_hash!==fingerprint)throw new HttpError(409,'This request identifier was used for different booking details.');
      if(row.status==='failed')throw new HttpError(409,'That request was not booked. Refresh availability and choose a time again.','booking_failed');
      if(row.status==='pending')await this.process(row.id);
      return this.get(row.id);
    }
    if(!this.config.demo && !this.google.account())throw new HttpError(503,'The host has not connected Google Calendar yet.');
    const candidates=this.candidates(slug,dateKey(start,timezone),1,timezone);
    const slot=candidates.find(s=>s.start===start); if(!slot)throw new HttpError(409,'That time is no longer available. Please choose another.','slot_unavailable');
    const eventType=getEventType(this.db,slug),host=readSetting(this.db,'host');
    const now=Date.now(),id=randomUUID(),googleId=randomUUID().replaceAll('-','');
    row=transaction(this.db,()=>{
      const existing=this.db.prepare('SELECT * FROM bookings WHERE key_hash=?').get(hash(key));
      if(existing) {
        if(existing.request_hash!==fingerprint)throw new HttpError(409,'Request identifier mismatch.');
        return existing;
      }
      const conflict=this.db.prepare("SELECT id FROM bookings WHERE status IN ('pending','confirmed') AND block_start < ? AND block_end > ? LIMIT 1").get(slot.blockEnd,slot.blockStart);
      if(conflict)throw new HttpError(409,'Someone just reserved that time. Please choose another.','slot_unavailable');
      this.db.prepare(`INSERT INTO bookings(id,key_hash,request_hash,event_type_id,slug,title,name,email,notes,timezone,host_timezone,start,end,block_start,block_end,status,google_event_id,calendar_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(id,hash(key),fingerprint,eventType.id,slug,eventType.title,name,email,notes,timezone,host.timezone,start,slot.end,slot.blockStart,slot.blockEnd,googleId,this.google.account()?.calendar_id||'demo',now,now);
      return this.get(id);
    });
    await this.process(row.id);
    row=this.get(row.id);
    if(row.status==='failed')throw new HttpError(409,'That time could not be booked. Refresh availability and choose another.','booking_failed');
    return row;
  }
  finalize(row,event) {
    if(event.status==='cancelled' && event.id===row.google_event_id) {
      this.db.prepare("UPDATE bookings SET status='cancelled',updated_at=? WHERE id=? AND status IN ('pending','confirmed')").run(Date.now(),row.id);return;
    }
    if(event.id!==row.google_event_id || event.extendedProperties?.private?.meetlyBookingId!==row.id) {
      this.db.prepare('UPDATE bookings SET needs_review=1,updated_at=? WHERE id=?').run(Date.now(),row.id);return;
    }
    const meet=event.conferenceData?.entryPoints?.find(p=>p.entryPointType==='video')?.uri || event.hangoutLink || null;
    const safeMeet=meet && /^https:\/\/meet\.google\.com\//.test(meet) ? meet:null;
    const calendar=event.htmlLink && /^https:\/\/calendar\.google\.com\//.test(event.htmlLink)?event.htmlLink:null;
    const conference=event.conferenceData?.createRequest?.status?.statusCode || (safeMeet?'success':'pending');
    this.db.prepare("UPDATE bookings SET status='confirmed',meet_url=?,calendar_url=?,ical_uid=COALESCE(?,ical_uid),conference_status=?,needs_review=?,updated_at=? WHERE id=? AND status IN ('pending','confirmed')").run(safeMeet,calendar,typeof event.iCalUID==='string'?event.iCalUID:null,conference,conference==='failure'?1:0,Date.now(),row.id);
  }
  async process(id) {
    if(this.running.has(id))return;
    let row=this.get(id);if(!row||row.status!=='pending')return;
    const now=Date.now();
    // This persisted lease coordinates workers; durable reservations never expire blindly.
    const claimed=this.db.prepare("UPDATE bookings SET attempt_at=? WHERE id=? AND status='pending' AND (attempt_at=0 OR attempt_at < ?)").run(now,id,now-90000);
    if(!claimed.changes)return;
    this.running.add(id);
    try {
      if(this.config.demo) {
        this.db.prepare("UPDATE bookings SET status='confirmed',conference_status='demo',updated_at=? WHERE id=?").run(Date.now(),id);return;
      }
      const retry=row.write_started===1;
      if(retry) {
        try {const existing=await this.google.get(row); this.finalize(row,existing);return;}
        catch(e) {if(e.status!==404)throw e;}
      }
      if (row.start <= Date.now()) { this.db.prepare('UPDATE bookings SET needs_review=1,updated_at=? WHERE id=?').run(Date.now(),id); return; }
      const busy=await this.google.freeBusy(row.block_start,row.block_end,[row.calendar_id]);
      if(busy.some(b=>overlaps(row.block_start,row.block_end,b.start,b.end))) {
        if(retry) {this.db.prepare('UPDATE bookings SET needs_review=1,updated_at=? WHERE id=?').run(Date.now(),id);return;}
        this.db.prepare("UPDATE bookings SET status='failed',updated_at=? WHERE id=?").run(Date.now(),id);return;
      }
      this.db.prepare('UPDATE bookings SET write_started=1 WHERE id=?').run(id);
      try {this.finalize(row,await this.google.insert(row));}
      catch(e) {
        // Stable event IDs turn a repeated insert into a conflict, never another event.
        if(e.status===409) {this.finalize(row,await this.google.get(row));return;}
        // Only definitive insert rejections are safe to release. A timeout/5xx is unknown.
        if([400,401,403,404,422].includes(e.status) && !retry) this.db.prepare("UPDATE bookings SET status='failed',updated_at=? WHERE id=?").run(Date.now(),id);
        else this.db.prepare('UPDATE bookings SET needs_review=1,updated_at=? WHERE id=?').run(Date.now(),id);
      }
    } catch {
      // A read-only failure before any insert has a known no-write outcome.
      // If an insert may have reached Google, preserve its durable reservation.
      if (!this.get(id).write_started) this.db.prepare("UPDATE bookings SET status='failed',updated_at=? WHERE id=?").run(Date.now(),id);
      else this.db.prepare('UPDATE bookings SET needs_review=1,updated_at=? WHERE id=?').run(Date.now(),id);
    } finally {this.running.delete(id);}
  }
  async reconcile() {
    const pending=this.db.prepare("SELECT id FROM bookings WHERE status='pending' AND attempt_at < ? ORDER BY attempt_at,created_at LIMIT 10").all(Date.now()-90000);
    for(const row of pending)await this.process(row.id);
    if(!this.config.demo && this.google.account()) {
      const rows=this.db.prepare("SELECT * FROM bookings WHERE status='confirmed' AND conference_status='pending' ORDER BY updated_at LIMIT 5").all();
      for(const row of rows) {try{this.finalize(row,await this.google.get(row));}catch{/* Keep verified calendar booking; try later. */}}
    }
  }
  status(key) {const row=this.db.prepare('SELECT * FROM bookings WHERE key_hash=?').get(hash(key||''));if(!row)throw new HttpError(404,'Booking not found.');return row;}
  async cancel(id) {
    const row=this.get(id);if(!row)throw new HttpError(404,'Booking not found.');
    if(row.status==='pending')throw new HttpError(409,'This booking is still being reconciled. Check Google Calendar before retrying.');
    if(row.status==='cancelled'||row.status==='failed')return row;
    if(!this.config.demo)await this.google.remove(row);
    this.db.prepare("UPDATE bookings SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(),id);return this.get(id);
  }
}
