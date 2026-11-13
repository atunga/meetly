import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function openDatabase(path, host = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true, mode:0o700});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS event_types (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, durationMinutes INTEGER NOT NULL CHECK(durationMinutes BETWEEN 5 AND 480), color TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    event_type_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, notes TEXT NOT NULL,
    timezone TEXT NOT NULL, host_timezone TEXT NOT NULL,
    start INTEGER NOT NULL, end INTEGER NOT NULL, block_start INTEGER NOT NULL, block_end INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed','cancelled')),
    google_event_id TEXT NOT NULL UNIQUE, calendar_id TEXT NOT NULL, meet_url TEXT, calendar_url TEXT, ical_uid TEXT,
    conference_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    attempt_at INTEGER NOT NULL DEFAULT 0, needs_review INTEGER NOT NULL DEFAULT 0, write_started INTEGER NOT NULL DEFAULT 0,
    CHECK(start < end), CHECK(block_start <= start), CHECK(block_end >= end)
  );
  CREATE INDEX IF NOT EXISTS bookings_overlap ON bookings(status, block_start, block_end);
  CREATE TABLE IF NOT EXISTS admin_sessions (id_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, session_hash TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS google_account (id INTEGER PRIMARY KEY CHECK(id=1), sub TEXT NOT NULL, email TEXT NOT NULL, refresh_token TEXT NOT NULL, calendar_id TEXT NOT NULL, conflict_calendars TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  // Additive upgrade for databases created before portable ICS downloads.
  if(!db.prepare('PRAGMA table_info(bookings)').all().some(column=>column.name==='ical_uid')) db.exec('ALTER TABLE bookings ADD COLUMN ical_uid TEXT');
  const set = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  set.run('host', JSON.stringify({name:host.name || 'Your name', bio:'Good conversations start with a little time. Choose a meeting below and find a moment that works for you.', timezone:host.timezone || 'UTC'}));
  set.run('scheduling', JSON.stringify({noticeMinutes:120,horizonDays:60,bufferBeforeMinutes:0,bufferAfterMinutes:10,slotStepMinutes:15}));
  set.run('availability', JSON.stringify([1,2,3,4,5].map(weekday => ({weekday,startMinute:540,endMinute:1020}))));
  const alreadySeeded = db.prepare("SELECT value FROM settings WHERE key='seeded'").get();
  const seed = db.prepare('INSERT OR IGNORE INTO event_types(id,slug,title,description,durationMinutes,color,active) VALUES(?,?,?,?,?,?,1)');
  if (!alreadySeeded) {
  seed.run('intro','quick-intro','A quick hello','A short introduction to connect, ask a question, or explore an idea.',15,'#355cce');
  seed.run('conversation','conversation','Let’s talk','A little more room for a thoughtful conversation and next steps.',30,'#8b6caf');
  seed.run('deep-dive','deep-dive','The deep dive','Bring your ideas. We’ll make space to work through the details together.',60,'#35866b');
  set.run('seeded', 'true');
  }
  return db;
}
export function readSetting(db, key) { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value); }
export function writeSetting(db,key,value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
export function transaction(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } }
export function takeRate(db, key, max, windowMs, now = Date.now()) {
  return transaction(db,()=>{
    db.prepare('DELETE FROM rate_limits WHERE expires < ?').run(now);
    const row=db.prepare('SELECT count,expires FROM rate_limits WHERE key=?').get(key);
    if (row && row.count>=max) return false;
    db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+windowMs);
    return true;
  });
}
