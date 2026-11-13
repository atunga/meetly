# Security

Meetly is a single-host, single-instance scheduling application. Self-hosting makes you responsible for its secrets, Google configuration, HTTPS, disk access, updates, backups, monitoring, and privacy notices. It has not received an independent security audit.

## Deployment requirements

- Use a unique strong `ADMIN_PASSWORD` (at least 16 characters), a random 64-hex-character `TOKEN_ENCRYPTION_KEY`, and your own Google OAuth Web client. Never commit `.env`, tokens, database files, or backups.
- Set `HOST_EMAIL` to the verified Google account you intend to connect. This restricts OAuth connection; it is not guest email verification. `HOST_NAME` and `HOST_TIMEZONE` only initialize a fresh public profile.
- Expose the public app only through HTTPS. Keep the backend port private behind a trusted proxy. Enable `TRUST_PROXY` only when that proxy overwrites client-supplied forwarded headers.
- Use one persistent instance and local SQLite storage. Do not use ephemeral/serverless storage, multiple replicas, or a shared network filesystem.
- Never expose demo mode. It uses a known password and an in-memory database. Demo rejects non-loopback binds; live mode rejects that known password. Do not bypass these boundaries with a public reverse proxy.

Run `npm run audit:release` before distributing the allowlisted source. The audit is not a complete secret scanner and does not examine arbitrary unlisted files. Keep `backups/` out of source control and perform a manual secret/data review too.

## Implemented safeguards

Admin access uses a standalone password, not ChatGPT account sign-in. Password verification uses scrypt and a timing-safe comparison. Sessions use hashed identifiers, HttpOnly/SameSite cookies, Secure cookies on HTTPS, and 12-hour expiry. Admin writes check the origin and CSRF token. Changing the password and restarting invalidates existing sessions and unfinished OAuth requests.

Google connection uses session-bound OAuth state, PKCE, verified email/account restriction, and server-side offline access. Refresh tokens and stored PKCE verifiers are encrypted with AES-256-GCM. OAuth scopes are documented in [Deployment](docs/DEPLOYMENT.md). The browser never needs the OAuth client secret or refresh token.

Rate limits, request-size/input checks, and browser security headers reduce common abuse. The booking form has no complete CAPTCHA integration or verified-email requirement. Public deployment still needs monitoring and appropriate edge protection.

## Data and booking limitations

The database is not fully encrypted. Guest names, emails, notes, and booking details are plaintext at rest, and relevant details are sent to Google Calendar. Protect local disks and encrypt backups. Keep the matching encryption key separately recoverable; changing it without re-encrypting existing data breaks token access.

Google invitation requests use `sendUpdates=all`. There is no separate SMTP/reminder service or guarantee of invitation delivery. Optional ICS files for confirmed bookings with a Meet URL are personal calendar copies, not invitation messages or email attachments. They omit scheduling `METHOD`, `ATTENDEE`, and `ORGANIZER` fields and are available only through the booking response, unguessable-key status lookup, or owner-admin access, not a public booking-ID download. Keep these files private: they contain meeting information and the Meet URL. Imported copies do not auto-update/cancel and may duplicate an accepted invitation depending on the calendar client. Calendar availability checks and event insertion are separate Google operations, so direct external edits can race bookings. Ambiguous responses retain pending holds for reconciliation rather than risk duplicate events or bookings. See [Operations](docs/OPERATIONS.md) before attempting repairs.

## Reporting and responding to an issue

No dedicated security-reporting address or response-time commitment is included in this package. Use a repository's private vulnerability-reporting mechanism if its publisher enables one; otherwise request a private contact channel from the publisher. Do not post passwords, OAuth tokens, guest data, backups, or exploitable details in a public issue.

For a compromised deployment, restrict access, preserve evidence privately, rotate the admin password and restart, and review Google authorization and active bookings. Revoke exposed credentials through the issuing service. Do not blindly delete pending bookings or rotate the encryption key without a recovery plan. Follow the backup and incident guidance in [Operations](docs/OPERATIONS.md).
