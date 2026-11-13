// RFC 5545 calendar download. It is a personal copy, never an invitation request.
export function escapeIcsText(value) {
  return String(value??'').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').replace(/;/g,'\\;').replace(/,/g,'\\,');
}
export function foldIcsLine(line) {
  const lines=[];let current='',bytes=0;
  for(const character of line) {
    const size=Buffer.byteLength(character,'utf8');
    if(bytes+size>75){lines.push(current);current=' ';bytes=1;}
    current+=character;bytes+=size;
  }
  lines.push(current);return lines.join('\r\n');
}
function stamp(ms) {return new Date(ms).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');}
export function bookingIcs(row) {
  if(row.status!=='confirmed'||!row.meet_url||![row.start,row.end,row.created_at].every(ms=>Number.isFinite(ms)&&Number.isFinite(new Date(ms).getTime()))||row.end<=row.start)return null;
  let meet;
  try {meet=new URL(row.meet_url);if(/[\r\n]/.test(row.meet_url)||meet.protocol!=='https:'||meet.hostname!=='meet.google.com'||meet.username||meet.password||meet.port)return null;}catch{return null;}
  const uid=row.ical_uid||`${row.google_event_id||row.id}@meetly.invalid`;
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Meetly//Booking//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',
    `UID:${escapeIcsText(uid)}`,`DTSTAMP:${stamp(row.created_at)}`,`DTSTART:${stamp(row.start)}`,`DTEND:${stamp(row.end)}`,
    `SUMMARY:${escapeIcsText(`${row.title} · ${row.name}`)}`,
    `DESCRIPTION:${escapeIcsText('Join your scheduled meeting using the Google Meet link. This download is a personal calendar copy, not a new invitation.')}`,
    `LOCATION:${escapeIcsText(meet.href)}`,`URL:${meet.href}`,'STATUS:CONFIRMED','TRANSP:OPAQUE','SEQUENCE:0','END:VEVENT','END:VCALENDAR'];
  return lines.map(foldIcsLine).join('\r\n')+'\r\n';
}
