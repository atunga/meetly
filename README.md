# Meetly

A portable, self-hosted, single-host scheduling app with shareable booking pages, multiple meeting lengths, Google Calendar conflict checks, and Google Meet creation. Built with Node.js 24, built-in SQLite, and a dependency-free browser UI. No npm dependency installation or frontend build is required.

## Try it locally

```sh
node --version # use Node 24.x
npm run demo
```

Open **http://localhost:3000**. Sign in at **/admin** with `meetly-demo-only`. Demo mode uses an in-memory database, requires a loopback bind, and creates **no Google events, invitations, or real Meet links**. Changes disappear on restart. Do not expose demo mode publicly; unset inherited `NODE_ENV=production`, `APP_URL`, or `HOST` overrides when trying it.

## Deploy your real booking page

1. Follow [Deployment](docs/DEPLOYMENT.md) to configure a domain, HTTPS, a persistent server, and a Google Cloud **Web application** OAuth client.
2. Copy `.env.example` to `.env`. Run `npm run secrets` locally, then put the generated values into your private `.env` or hosting secrets. This command only prints secrets; it does not save them. Set `APP_URL`, required `HOST_NAME` and `HOST_EMAIL`, optional `HOST_TIMEZONE` (defaults to `UTC`), and your own `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `HOST_EMAIL` pins the permitted Google account; it is not published on the profile. Never commit `.env`.
3. Run `docker compose up -d --build`. The included Compose file exposes only `127.0.0.1:3000` and stores SQLite in the named `meetly-data` volume. Use an HTTPS reverse proxy for public access.
4. Visit `https://YOUR_DOMAIN/admin`. In **Settings & calendar**, set your name, bio, host time zone, notice, booking window, and buffers. Connect Google, select a calendar you **own** that supports Meet, and select calendars to check for conflicts.
5. Set weekly hours under **Availability**. Create or edit 5–480-minute meetings under **Event types**, then copy each `/book/your-slug` link to share on social accounts. The profile at `/` lists active meeting types. New databases start with 15-, 30-, and 60-minute examples; edit them before sharing.
6. Make a real test booking with a second email address before launching. Confirm the correct calendar, timezone, conflict handling, invitation, and working Meet link. This live Google test has **not** been performed as part of this build.

For a non-Docker server, use Node 24.x and `npm start`; it loads `.env` and needs a process supervisor and a persistent database directory.

Each installation supplies its own Google OAuth Web client, secrets, and persistent database. Admin access uses `ADMIN_PASSWORD`, not ChatGPT account sign-in. Host name and timezone seed a fresh database only; later dashboard edits persist across restarts.

## Checks

```sh
npm run check
npm test
npm run audit:release
```

The release audit checks the 33-file `release-files.json` allowlist for runtime files and recognized credential patterns. It is not a complete secret scanner; review changes manually before sharing.

## Important boundaries

- One host, one connected Google account, one persistent application instance. Not a serverless, ephemeral-storage, multi-region, or multi-user service.
- Google handles invitation requests through Calendar `sendUpdates=all`. There is no separate SMTP service, reminder system, or guarantee of email delivery. Confirmed live bookings with a Meet link offer an optional `.ics` download as a manual calendar copy, not an email attachment. Importing it as well as accepting the Google invitation may create a duplicate; the downloaded copy does not auto-update or cancel.
- Local reservations protect concurrent app bookings. Google FreeBusy and event insertion are separate operations, so a direct external calendar edit can still race a booking.
- Ambiguous Google responses retain pending reservations and retry safely using a stable event ID. Some require manual review; do not delete pending rows just to free time.
- Admin cancellation is supported. Guest self-service cancellation/rescheduling, date-specific overrides, payments, team routing, and full bidirectional calendar synchronization are not implemented.
- Guest name, email, timezone, and notes are stored locally and included as appropriate in Google Calendar events. Only OAuth tokens are encrypted in the database; protect the database and backups.

Read [Operations](docs/OPERATIONS.md) for backups, incident recovery, privacy, and the exact API behavior. No production credentials, cloud resources, or live deployment are included.

[Verification details](docs/TESTING.md) distinguish local/mocked checks from the live test every deployment needs. Review [Security](SECURITY.md) before public use. Released under the [MIT License](LICENSE).
