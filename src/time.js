import { HttpError } from './security.js';
const formatters = new Map();
export function isTimezone(zone) { try { if (typeof zone !== 'string' || zone.length > 80) return false; new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(); return true; } catch {return false;} }
export function parts(ms, zone) {
  let f = formatters.get(zone);
  if (!f) { f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); formatters.set(zone,f); }
  return Object.fromEntries(f.formatToParts(ms).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
export function dateKey(ms,zone) {const p=parts(ms,zone); return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
export function parseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400,'Use a date in YYYY-MM-DD format.');
  const [y,m,d]=date.split('-').map(Number), n=Date.UTC(y,m-1,d);
  if (new Date(n).toISOString().slice(0,10)!==date) throw new HttpError(400,'Invalid date.');
  return n;
}
export function addDays(date,days) {return new Date(parseDate(date)+days*86400000).toISOString().slice(0,10);}
// Resolve a wall-clock minute using all offsets around that date. Nonexistent DST
// minutes have no result; repeated minutes yield BOTH distinct UTC instants.
export function wallInstants(date,minute,zone) {
  const base=parseDate(date)+minute*60000, offsets=new Set();
  for (const delta of [-36,-12,0,12,36]) {
    const t=base+delta*3600000, p=parts(t,zone);
    offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-t);
  }
  const expected=base, results=[];
  for (const offset of offsets) {
    const utc=base-offset, p=parts(utc,zone);
    if (Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)===expected) results.push(utc);
  }
  return results.sort((a,b)=>a-b);
}
export function overlaps(start,end,busyStart,busyEnd) { return start < busyEnd && end > busyStart; }
export function makeCandidates({eventType, host, settings, availability, from, days, timezone, now=Date.now()}) {
  if (!isTimezone(timezone)) throw new HttpError(400,'Choose a valid time zone.');
  const fromEpoch=parseDate(from), today=parseDate(dateKey(now,timezone));
  if (fromEpoch < today-86400000 || fromEpoch > today+(settings.horizonDays+1)*86400000) throw new HttpError(400,'Choose a date inside the booking window.');
  if (!Number.isInteger(days) || days<1 || days>31) throw new HttpError(400,'Request between 1 and 31 days.');
  const to=addDays(from,days), firstHost=addDays(from,-2), candidates=new Map();
  for(let i=0;i<days+4;i++) {
    const date=addDays(firstHost,i), weekday=new Date(parseDate(date)).getUTCDay();
    for(const window of availability.filter(w=>w.weekday===weekday)) {
      for(let minute=window.startMinute; minute+eventType.durationMinutes<=window.endMinute; minute+=settings.slotStepMinutes) {
        for (const start of wallInstants(date,minute,host.timezone)) {
          const end=start+eventType.durationMinutes*60000;
          const endParts=parts(end-1,host.timezone);
          // Reject intervals that cross a DST discontinuity outside working hours.
          const endWall=endParts.hour*60+endParts.minute+1;
          if(dateKey(end-1,host.timezone)!==date || endWall>window.endMinute || endWall<=minute) continue;
          if(start<now+settings.noticeMinutes*60000 || start>now+settings.horizonDays*86400000) continue;
          const guestDate=dateKey(start,timezone); if(guestDate<from || guestDate>=to) continue;
          candidates.set(start,{start,end,blockStart:start-settings.bufferBeforeMinutes*60000,blockEnd:end+settings.bufferAfterMinutes*60000});
        }
      }
    }
  }
  return [...candidates.values()].sort((a,b)=>a.start-b.start);
}
export function subtractBusy(candidates,busy) {return candidates.filter(s=>!busy.some(b=>overlaps(s.blockStart,s.blockEnd,b.start,b.end)));}
