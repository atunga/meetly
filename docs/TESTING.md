# Verification and launch testing

## Portable release

Run from the project directory with Node.js 24.x:

```sh
npm run check
npm test
npm run audit:release
```

The test suite uses local HTTP and mocked Google responses. It covers scheduling/timezones, overlap prevention, retries and reconciliation, persistence, admin authentication/CSRF, encrypted tokens, OAuth state/PKCE, and Google event/Meet request construction. These checks do not validate a real OAuth consent screen, Google account permissions, invitation delivery, or a deployment's networking/storage.

This document does not assert a fresh live Google test, a Docker build pass, public publication, or independent security certification for this portable release. A separately hosted upstream variant completed real Google event and Meet creation followed by cancellation. That result does not transfer its credentials, authorization, hosting, or live-test status to this package.

## Local verification record

On 2026-11-13 with Node.js 24.22.1, the current portable candidate passed:

- 47/47 automated tests, including ICS generation/escaping/folding and booking access cases.
- JavaScript syntax checks.
- The 33-file release audit.
- Standalone-process startup and profile/admin/assets HTTP smoke checks.

A private-data/identity scan also passed during release preparation. These are local results, not Docker, CI, fresh browser QA, or a fresh live Google test.

## Release audit and CI

`release-files.json` lists the 32 source files intended for distribution. `npm run audit:release` validates manifest paths and files, rejects runtime-file entries and recognized credential/hosted-identity patterns, and checks that credential fields in `.env.example` are blank. It checks the allowlist, not every unlisted file or every possible secret. Package only reviewed allowlisted files, keep `backups/` out of source control, and review changes manually.

The included GitHub Actions workflow is configured to run syntax checks, tests, the release audit, and a Docker build/startup smoke test on pushes and pull requests once published. No CI run is claimed here. The preparation environment had no Docker binary or fresh browser-QA capability, so this portable candidate has no claimed Docker pass or fresh UI pass. No new live Google events were created for its verification.

## Required checks for your installation

1. Run the commands above and record the actual results for the version deployed.
2. If using Docker, build/start the image, check `/healthz`, and verify that profile settings and bookings survive container recreation with the same persistent volume.
3. Use the demo to inspect public/profile booking links, date and timezone selection, admin login, event creation/editing, hours/settings, booking confirmation and cancellation. Check both a desktop and a phone. Demo generates no real Google events or Meet links.
4. Configure your own Google Web OAuth client and account restriction, then connect through the real deployed HTTPS origin. Verify the chosen calendar and conflict calendars.
5. Make a real booking with a second email address. Confirm exactly one event, the correct timezone/duration, the attendee invitation request, and a working Google Meet link. Check recipient delivery separately; an API success does not prove email delivery.
6. For a confirmed live booking with a Meet URL, verify the optional ICS file imports with the correct time and link. Avoid importing it into the same calendar that already accepted the invitation unless testing duplicate handling. Verify a busy calendar event blocks the intended slot and a retry does not create a duplicate. Cancel the test booking through the dashboard and verify cancellation in Google Calendar.
7. Rehearse backup/restore safely and confirm an operator can recognize pending reservations and failed conference generation.

Use the [deployment checklist](DEPLOYMENT.md#launch-checklist) before sharing public links. Do not use demo output or mocked test success as proof that live calendar booking works.
