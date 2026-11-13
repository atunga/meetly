# Operations and security

## Day-to-day administration

Sign in at `/admin`. Sessions last 12 hours. There is one shared host/admin password, not separate users or roles. This standalone edition does not use ChatGPT account authentication. `HOST_EMAIL` restricts Google connection to the configured verified email and is not exposed on the public profile. `HOST_NAME` and `HOST_TIMEZONE` initialize a fresh database only; profile edits in the dashboard persist across environment changes and restarts.

- **Event types:** Create up to 50 types, each with a unique lowercase alphanumeric/hyphen slug, title, description, duration from 5 to 480 minutes, color, and active state. Share `/book/SLUG`; inactive or deleted types no longer accept bookings. Editing or deleting a type does not change existing bookings. Changing its slug breaks the old public link.
- **Availability:** Weekly hours use the host's IANA timezone. The UI edits one window per day and replaces any existing multiple windows when saving. The API permits up to 28 non-overlapping same-day windows. Split overnight hours across days; there are no date-specific overrides. Use busy calendar events to block days off.
- **Settings & calendar:** Set name/bio/timezone, notice (0–43,200 minutes), horizon (1–365 days), before/after buffers (0–120 minutes each), and start interval (5–120 minutes). All are integers. Buffers block conflicts around a meeting but may extend beyond weekly working hours; the meeting itself must fit the hours. Defaults are two hours' notice, 60 days ahead, zero before/10 minutes after, and 15-minute starts.
- **Calendar selection:** The destination must be owned by the connected account and allow Meet. Select 1–50 conflict calendars. The destination is included automatically. If any selected calendar's FreeBusy result is missing or erroneous, availability fails closed rather than showing potentially unsafe slots.
- **Bookings:** The dashboard shows up to the latest 200 rows ordered by meeting start, including status/review flags. Cancel confirmed bookings here so Google deletion and the local cancellation are coordinated. Google receives `sendUpdates=all`; delivery is controlled by Google and recipient settings.

Server text limits: host name 80 characters, bio 600, event title 100, description 1,000, slug 80, guest name 100, guest notes 2,000, and email 254. JSON request bodies are capped at 16 KiB.

The app does not continuously synchronize every external event edit/deletion. Confirmed local bookings continue to block their original time until cancelled through the app. Changing Google Calendar directly can therefore leave stale local holds. Do not promise fully bidirectional synchronization or guest rescheduling.

## Booking guarantees and limitations

A transaction creates a durable local `pending` reservation before talking to Google. All pending and confirmed reservations participate in overlap checks, including buffers. Requests use an idempotency key, a payload fingerprint, and a stable Google event ID; identical retries reuse the original request. Reusing a key with changed details is rejected.

FreeBusy is checked again before insertion. It is **not atomic** with Google's event insert operation. A concurrent booking through this app is protected by SQLite reservations, but an external direct Google Calendar edit can occur between that check and insertion. This is a single-instance design, not a distributed scheduling lock.

The background worker runs every 30 seconds. Pending attempts use a persisted 90-second lease; a retry first looks up the stable Google event ID before attempting another insertion. It processes up to 10 eligible pending rows per pass and polls up to 5 confirmed events whose Meet conference is still pending. These are best-effort intervals, not completion guarantees.

- `pending`: not confirmed; the time remains blocked. A timeout or ambiguous API response does not release it.
- `confirmed`: Google event verified. Meet may still be pending or may have failed separately.
- `failed`: a definitive initial rejection, conflict, or read-only failure before any insert released the reservation.
- `cancelled`: the booking is no longer held locally.
- `needsReview`: inspect the real Google event and credentials; it is not permission to delete the row.

When an event exists but Meet generation fails, the calendar booking remains confirmed and flagged for review. Arrange the correct link directly in Google Calendar if appropriate and communicate with the guest yourself. The app has no general manual repair UI or automatic retry workflow for a definitively failed conference request.

## Optional calendar download

Confirmed live bookings with a valid Google Meet URL offer **Download calendar file (.ics)** on confirmation/status. Pending bookings, pending Meet creation, demo reservations, and cancelled bookings do not offer it. This is an optional manual copy for a calendar client, not SMTP, a separately sent invitation, or an email attachment.

The server generates a personal calendar file without scheduling `METHOD`, `ATTENDEE`, or `ORGANIZER` fields. It escapes text, uses CRLF line endings, and folds lines by UTF-8 bytes. It reuses Google's `iCalUID` when available, with a local fallback for older records. The `ics` field is returned with the booking response, status lookup authorized by the unguessable idempotency key, or owner-admin access. There is no public download by booking ID.

Accepting Google's invitation and importing the file may create duplicate entries depending on the calendar client. Prefer the invitation when it works. A downloaded/imported copy does not automatically update or cancel when the live event changes. Delete or update that personal copy yourself if needed. Treat the file and booking-status key as private: the file contains the guest name, meeting title/time, and Meet URL.

## Pending reservations and incidents

1. Check `/admin` for status and review flags. Check Google Calendar for the corresponding event before making any changes. An HTTP timeout does not establish that Google failed to create it.
2. Confirm the service is running, outbound Google requests work, the correct encryption key is loaded, and Google consent/token validity is intact. After fixing connectivity or reconnecting the same account, click **Check pending bookings** in the Bookings tab or allow the worker time to reconcile. The button runs one reconciliation pass; it respects the 90-second lease and does not force-release holds or guarantee every row is resolved.
3. For deeper inspection, an operator can read the booking's `id`, `google_event_id`, `calendar_id`, `attempt_at`, `write_started`, and status in SQLite and compare them with the Google event, including its private `meetlyBookingId` property. Do not log guest details or tokens unnecessarily.
4. If a retry finds an overlapping external event, the meeting start has passed, or identity does not match, the reservation may remain pending and require a reviewed repair. Keep it blocked until there is evidence of the exact Google outcome.
5. There is intentionally no force-release endpoint. **Do not auto-delete pending SQL rows, expire them by age, or alter IDs to make retries succeed.** Back up the database, establish whether the event exists or was cancelled, and have a maintainer design a specific consistent repair if automatic reconciliation cannot resolve it.

Pending bookings cannot be cancelled through the existing cancellation endpoint. Disconnect is blocked while any booking is pending or a confirmed meeting has not ended, so that events remain manageable. A reconnect of the same Google account can refresh consent; use **Reconnect Google** in Settings & calendar without disconnecting. Do not edit the token table directly. Switching to a different Google account requires resolving bookings, disconnecting first, updating `HOST_EMAIL`, and restarting with the new account restriction. Disconnect removes the local connection; it does not revoke Google's authorization grant. Revocation is a separate Google-account security action.

## Backups and restores

SQLite uses WAL mode. Copying only a live `.sqlite` file can omit committed data or yield an inconsistent snapshot. Use SQLite's online backup API/tooling or stop the app and copy the **entire data directory**. Backups contain guest personal data and encrypted OAuth tokens. Keep the matching `TOKEN_ENCRYPTION_KEY` separately secured and recoverable with the backup, along with required deployment configuration and Google client credentials. Losing that key prevents decrypting the saved refresh token.

### Simple Docker backup with a maintenance window

Run from the deployment directory. The following uses a new directory and stops the writer for a consistent copy:

```sh
BACKUP_DIR="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$PWD/backups" "$BACKUP_DIR"
docker compose stop meetly
docker compose cp meetly:/app/data "$BACKUP_DIR/"
docker compose start meetly
```

Check that the copy succeeded and `"$BACKUP_DIR/data/meetly.sqlite"` exists before treating it as a backup. If the copy fails, still restart the service and investigate. Encrypt stored backups, restrict access, and keep an off-host copy under your control. Do not expose backup directories through a web server. Keep `backups/` ignored by version control and excluded from release archives. Retain any WAL/SHM files copied with the stopped database as part of the same snapshot, not from a different backup. For native Node, stop the supervisor first, copy the complete database directory, then restart it.

### Restore procedure

1. Verify the chosen backup, matching encryption key, and Google client configuration. Stop the app. Preserve the current entire data directory as a separate recovery snapshot before replacing anything.
2. Restore the backup's complete data directory to the persistent volume, without mixing old WAL/SHM files with another database snapshot. Use your host/volume backup tool; verify the restored directory is writable by the container's `node` user. Do not delete the only current copy to make room.
3. Restore the matching secrets privately, then start exactly one instance. Check `/healthz`, admin settings, Google connection, and bookings.
4. **Reconcile events created after the backup.** Restoring local state does not roll Google Calendar back. Google FreeBusy may block those events, but the app will not automatically import all their missing booking records. Review both sources before reopening bookings.

Rehearse restores on an isolated copy. Never start a restored clone with production Google credentials and its worker enabled just to test a backup: it can retry real bookings. A read-only SQLite integrity check is a safer first verification.

## Upgrades and monitoring

Back up before every update. Rebuild with `docker compose up -d --build`; keep the volume and encryption key. The schema uses `CREATE TABLE IF NOT EXISTS` plus an additive migration that adds the optional `bookings.ical_uid` column to existing databases. There is no general versioned migration framework; future incompatible schema changes need an explicit migration and tested rollback plan. Do not replace the database to make an upgrade start.

```sh
docker compose ps
docker compose logs --tail=100 meetly
curl -fsS https://YOUR_DOMAIN/healthz
```

`/healthz` returns `ok` and `calendarConfigured`. The latter means Google client ID and secret are present, not that the account is connected or its token is valid. This endpoint does not verify Google availability, successful backups, disk free space, or end-to-end bookings. Monitor those separately and inspect review flags. Watch disk capacity: bookings are retained; there is no automatic personal-data retention policy. Synchronize the server clock and keep the Node 24 runtime/host security updates current.

### Troubleshooting

- **Origin mismatch / sign-in fails:** use the exact `APP_URL` origin, not the localhost upstream or a second alias. Restart after environment changes. HTTPS configurations require secure cookies.
- **redirect_uri_mismatch:** Google must list the exact `APP_URL` plus `/auth/google/callback` under the Web client's authorized redirect URIs.
- **Google access fails after about a week:** check External Testing token expiry, revoked consent, account policy, and client credentials. Reconnect the same account and review pending bookings.
- **Google connected but no slots:** check host timezone/hours, notice, horizon, buffers, busy calendars, local pending/confirmed holds, and FreeBusy access to every selected calendar.
- **Calendar rejected:** destination must have `owner` access and advertise `hangoutsMeet`; a shared writer calendar is not enough.
- **Meet link missing:** distinguish pending conference generation from a definite failure. Calendar confirmation alone is not proof of a working video link.
- **Rate limited behind a proxy:** validate trusted proxy configuration; do not blindly trust forwarded headers. Login is limited to 8 attempts per 15 minutes per address, availability to 60/minute, booking to 12/10 minutes, status to 60/minute, new booking attempts to 80/hour per host and 5/day per normalized email. Failed attempts can consume these limits.
- **Data disappears on restart:** check `DB_PATH`, disk mount, and Compose project name; ensure demo mode is off.
- **Token decryption fails:** restore the original encryption key. Changing it alone does not rotate/re-encrypt existing credentials.

## Security and privacy

The implementation uses scrypt/timing-safe admin password verification, hashed session IDs, HttpOnly/SameSite cookies (Secure on HTTPS), origin checks and CSRF tokens for admin writes, OAuth state tied to the admin session, PKCE, encrypted refresh tokens, rate limits, and restrictive browser headers. These are safeguards, not an independent security audit. The public booking form has no verified-email gate or complete CAPTCHA integration; consider abuse monitoring and a correctly configured edge rate limiter before broad promotion.

The encryption key and admin password remain private deployment secrets. AES-256-GCM protects refresh tokens and stored OAuth PKCE verifiers, **not the whole database**. Names, emails, notes, times, and other booking fields are plaintext at rest. Use appropriate host/disk encryption, restricted volume access, and encrypted backups. Browser booking keys act as access secrets for status lookup; do not publish them.

Guest names, email addresses, timezones, and notes are stored in SQLite. Google receives attendee information, event details, and notes to create the calendar event and conference. `sendUpdates=all` requests Google invitations/updates; Meetly does not run SMTP, send its own reminder emails, or verify invitation delivery. The optional ICS download is a manual calendar copy, not an email attachment. There is no automated erasure/retention workflow. Publish a privacy notice appropriate to your use, minimize sensitive notes, and handle deletion requests consistently in the database, Google Calendar, and retained backups.

Changing `ADMIN_PASSWORD` and restarting invalidates existing admin sessions and unfinished OAuth requests. For suspected admin-session compromise, rotate the password and restart the app promptly. Changing `TOKEN_ENCRYPTION_KEY` without an explicit decrypt/re-encrypt migration breaks stored credentials. Protect recovery copies and never paste keys into support logs.

## API reference (same-origin application)

This is the UI's JSON API, not a third-party integration API. Public write requests require `Origin` equal to `APP_URL`. JSON endpoints require `Content-Type: application/json`. Admin endpoints require the session cookie; admin writes additionally require the session's `X-CSRF-Token`.

- `GET /api/public/profile`: public host, active event types, connected/demo flags.
- `GET /api/public/event-types/:slug`: one active type and host.
- `GET /api/public/availability?slug=...&from=YYYY-MM-DD&days=14&timezone=...`: ISO slot instants in the guest's requested date range. `days` must be 1–31 and timezone must be an IANA identifier. Availability respects the configured horizon; it is not a reservation.
- `POST /api/public/bookings`: `slug`, `name`, `email`, optional `notes`, `timezone`, ISO `start`, and `idempotencyKey` (20–128 letters/digits/underscores/hyphens). New confirmed bookings return 201; pending return 202; successful identical existing requests return 200. Use the same key and payload when retrying an ambiguous request.
- `POST /api/public/bookings/status`: `idempotencyKey`; returns only that booking. Keep the key private.
- `GET /api/admin/session`; `POST /api/admin/login` with `password`; `POST /api/admin/logout`.
- `GET /api/admin/config`; `PUT /api/admin/config` with complete `host`, `settings`, and `availability` objects. Availability uses `weekday` 0–6 (Sunday–Saturday), `startMinute` 0–1439, and `endMinute` 1–1440, with start before end and no overlapping windows on the same day.
- `POST /api/admin/event-types`; `PUT /api/admin/event-types/:id`; `DELETE /api/admin/event-types/:id`. Event fields: `slug`, `title`, `description`, integer `durationMinutes`, six-digit hex `color`, boolean `active`.
- `POST /api/admin/reconcile`: authenticated, CSRF-protected reconciliation pass, used by **Check pending bookings**; respects leases and retains unresolved holds. Returns `ok`, not a per-booking success report.
- `GET /api/admin/bookings`; `POST /api/admin/bookings/:id/cancel` for confirmed bookings. No guest cancel/reschedule endpoint.
- `POST /api/admin/google/connect`: returns the Google consent URL. `GET /auth/google/callback` completes OAuth in the same admin session. `POST /api/admin/google/disconnect` removes the local connection only when there are no pending or upcoming confirmed bookings.
- `GET /api/admin/google/calendars`; `PUT /api/admin/google/calendars` with `calendarId` and `conflictCalendarIds`.
- `GET /healthz`: `ok` and `calendarConfigured`; no live Google/token health check.

Errors are JSON with `error` and `code`; Google errors are surfaced generically rather than leaking tokens or upstream response bodies. Review the code/tests when extending the API. Live Google OAuth/Calendar/Meet and invitation delivery have not been end-to-end tested in this build.
