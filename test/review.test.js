import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase, writeSetting } from '../src/db.js';
import { BookingService } from '../src/booking.js';
import { GoogleCalendar } from '../src/google.js';

function fixture() {
  const db = openDatabase(':memory:');
  const config = loadConfig({}, ['--demo']); config.demo = false;
  writeSetting(db, 'host', { name: 'Host', bio: '', timezone: 'UTC' });
  writeSetting(db, 'scheduling', { noticeMinutes: 0, horizonDays: 365, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, slotStepMinutes: 15 });
  writeSetting(db, 'availability', Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })));
  const events = new Map();
  const google = {
    account: () => ({ calendar_id: 'primary' }),
    freeBusy: async () => [],
    insert: async row => {
      const event = { id: row.google_event_id, status: 'confirmed', extendedProperties: { private: { meetlyBookingId: row.id } }, conferenceData: { createRequest: { status: { statusCode: 'pending' } } } };
      events.set(row.google_event_id, event); return event;
    },
    get: async row => events.get(row.google_event_id),
    remove: async () => {},
  };
  const booking = new BookingService(db, config, google);
  const input = { slug: 'conversation', name: 'Guest', email: 'guest@example.com', timezone: 'UTC', start: new Date(Math.ceil((Date.now() + 3 * 86400000) / 3600000) * 3600000).toISOString(), idempotencyKey: randomUUID() };
  return { db, config, google, booking, events, input };
}

test('Review: a late Meet response cannot resurrect an admin-cancelled booking', async () => {
  const f = fixture();
  try {
    const row = await f.booking.book(f.input);
    const delayedResponse = f.events.get(row.google_event_id);
    await f.booking.cancel(row.id);
    assert.equal(f.booking.get(row.id).status, 'cancelled');
    f.booking.finalize(row, delayedResponse);
    assert.equal(f.booking.get(row.id).status, 'cancelled');
  } finally { f.db.close(); }
});

test('Review: unknown insert followed by 404 and busy retains its reservation', async () => {
  const f = fixture();
  try {
    let writes = 0;
    f.google.insert = async () => { writes++; throw { status: 0 }; };
    const row = await f.booking.book(f.input);
    f.google.get = async () => { throw { status: 404 }; };
    f.google.freeBusy = async () => [{ start: row.start, end: row.end }];
    f.db.prepare('UPDATE bookings SET attempt_at=? WHERE id=?').run(Date.now() - 100000, row.id);
    await f.booking.process(row.id);
    assert.equal(f.booking.get(row.id).status, 'pending');
    assert.equal(f.booking.get(row.id).needs_review, 1);
    assert.equal(writes, 1);
  } finally { f.db.close(); }
});

test('Review: FreeBusy missing or malformed calendars fails closed', async () => {
  const f = fixture();
  try {
    const google = new GoogleCalendar(f.db, f.config);
    google.account = () => ({ calendar_id: 'primary', conflict_calendars: '["other"]' });
    for (const response of [
      { calendars: { primary: { busy: [] } } },
      { calendars: { primary: { busy: [] }, other: { busy: [{ start: 'invalid', end: 'invalid' }] } } },
      { calendars: { primary: { busy: [] }, other: { busy: [{ start: '2027-01-01T10:00:00Z', end: '2027-01-01T09:00:00Z' }] } } },
    ]) {
      google.api = async () => response;
      await assert.rejects(google.freeBusy(0, 3600000));
    }
  } finally { f.db.close(); }
});

test('Review: FreeBusy includes a pending booking original calendar after destination changes', async () => {
  const f = fixture();
  try {
    f.google.insert = async () => { throw { status: 0 }; };
    const row = await f.booking.book(f.input);
    f.google.account = () => ({ calendar_id: 'new-destination' });
    f.google.get = async () => { throw { status: 404 }; };
    let checked = [];
    f.google.freeBusy = async (_start, _end, extraCalendarIds = []) => { checked = extraCalendarIds; return []; };
    f.db.prepare('UPDATE bookings SET attempt_at=? WHERE id=?').run(Date.now() - 100000, row.id);
    await f.booking.process(row.id);
    assert.ok(checked.includes('primary'));
    assert.equal(f.booking.get(row.id).calendar_id, 'primary');
  } finally { f.db.close(); }
});

test('Review: FreeBusy sends union of selected and snapshotted calendars', async () => {
  const f = fixture();
  try {
    const google = new GoogleCalendar(f.db, f.config);
    google.account = () => ({ calendar_id: 'new-destination', conflict_calendars: '["new-destination","other"]' });
    let checked = [];
    google.api = async (_path, options) => {
      checked = JSON.parse(options.body).items.map(item => item.id);
      return { calendars: Object.fromEntries(checked.map(id => [id, { busy: [] }])) };
    };
    await google.freeBusy(0, 3600000, ['original-calendar']);
    assert.deepEqual(new Set(checked), new Set(['new-destination', 'other', 'original-calendar']));
    assert.equal(checked.length, 3);
  } finally { f.db.close(); }
});
