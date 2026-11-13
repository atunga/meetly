# Deployment

## Supported architecture

Run one long-lived Node.js 24.x process on one host with persistent local SQLite storage. A background reconciler runs in that process. The included Dockerfile uses Node 24 and runs as the unprivileged `node` user. The browser UI is served by the same process and origin.

Do not use Vercel Functions, ordinary serverless functions, ephemeral container storage, multiple replicas, multi-region deployments, or shared network filesystems for this SQLite app. Provision persistent disk, HTTPS, process restarts, backups, and outbound access to Google OAuth and Calendar endpoints. No deployment, Google credentials, or paid resources have been created for you.

## Environment

Start from `.env.example`:

```sh
cp .env.example .env
chmod 600 .env
npm run secrets
```

Copy the two printed values into `.env`; do not put the output in logs, source control, screenshots, or public chat.

- `NODE_ENV=production`: use for public deployment; blocks demo mode.
- `APP_URL=https://meet.example.com`: the exact public origin, without a path, query, or fragment. Use HTTPS publicly. This controls OAuth callbacks, origin checks, and secure cookies. A different hostname or scheme is not interchangeable.
- `PORT=3000`: process listening port; keep 3000 for the supplied Docker health check and Compose port mapping.
- `ADMIN_PASSWORD`: a unique password, at least 16 characters (maximum accepted login input is 512). Use a password manager. The known demo password is rejected outside demo mode.
- `TOKEN_ENCRYPTION_KEY`: exactly 64 hexadecimal characters, representing 32 random bytes. Keep this stable across restarts and restores.
- `DB_PATH=/app/data/meetly.sqlite`: recommended explicit Docker path. The example's `./data/meetly.sqlite` also resolves here because the container works in `/app`. For native Node, choose an absolute path on persistent local storage.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: your Google OAuth Web application credentials. Without both, the app can run but cannot connect Google or accept real bookings.
- `HOST_NAME`: required outside demo; your initial public profile name.
- `HOST_EMAIL`: required outside demo; the verified Google account allowed to connect. This is not exposed on the public profile. `OWNER_GOOGLE_EMAIL` is accepted as a legacy fallback when `HOST_EMAIL` is absent.
- `HOST_TIMEZONE=UTC`: optional initial host IANA timezone, for example `America/New_York`. Name and timezone seed only a fresh database; changes saved in the dashboard are not overwritten on restart. Edit an existing profile in the dashboard.

Each installation must use its own OAuth Web client, private runtime secrets, and database. `ADMIN_PASSWORD` provides standalone admin authentication; no ChatGPT account or hosted-app authorization is used.
- `TRUST_PROXY=false`: safe default. Enable only when the app is reachable solely through a trusted proxy that **overwrites** incoming `X-Forwarded-For`. The app uses its first value for rate limits. Leaving this false behind a proxy aggregates rate limits under the proxy address.
- `HOST`: optional bind override. With an HTTP `APP_URL`, the default is `127.0.0.1`; HTTPS live mode defaults to `0.0.0.0`. Demo defaults to `127.0.0.1` and rejects any non-loopback `HOST` or `--host` override. Use `HOST=127.0.0.1` for native Node behind a proxy on the same machine. The supplied Dockerfile explicitly sets `HOST=0.0.0.0` so its network interface is reachable; Compose still publishes port 3000 only on the host loopback address.

Keep `backups/` excluded from version control and release archives alongside `.env` and runtime data. Before distributing source, run `npm run audit:release` and review the allowlisted files manually.

Do not set `DEMO_MODE=true` for production. No CAPTCHA integration is included; use the built-in rate limits and appropriate edge abuse protection.

## Configure Google Calendar and Meet

Use the [Google Cloud console](https://console.cloud.google.com/). Console labels may vary.

1. Create or select a project. Enable **Google Calendar API** under APIs & Services.
2. Configure the Google Auth Platform/OAuth consent screen: app name, support email, audience, and developer contact. Use Internal only if your Google Workspace organization allows it; otherwise use External.
3. For an External app in **Testing**, add your own Google account as a test user. The host signs in to Google; booking guests do not need OAuth access or Google accounts.
4. Configure these exact requested scopes:
   - `openid`
   - `email`
   - `https://www.googleapis.com/auth/calendar.events.owned`
   - `https://www.googleapis.com/auth/calendar.events.freebusy`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
5. Create an OAuth client with application type **Web application**. Add this exact authorized redirect URI, replacing the hostname:
   ```text
   https://meet.example.com/auth/google/callback
   ```
   Match the origin in `APP_URL`, including any port for local development. Do not add a trailing slash to the callback. The flow is server-side; an authorized JavaScript origin is not needed by this implementation.
6. Save the client ID and secret privately in the app environment, then restart the app. Do not put the client secret in browser code.
7. Sign in at `/admin` on your configured public origin. Select **Settings & calendar → Connect Google Calendar**. Sign in with your intended host account and grant all requested calendar permissions. The callback must return to the same browser session.
8. Select a destination calendar you **own** whose allowed conference types include `hangoutsMeet`. Writer access alone is insufficient. Choose the calendars to check for conflicts and save. The destination is always checked as well. Ensure Google Meet is enabled for the account and, for Workspace, permitted by your administrator.

The connection requests offline access with consent and PKCE. Refresh tokens stay server-side encrypted with AES-256-GCM. The app does not use a service account or require domain-wide delegation.

**Testing expiry:** Google External apps in Testing generally receive refresh tokens that expire after seven days when these Calendar scopes are requested. Reconnect when necessary during development. For a durable deployment, configure Production publishing status and follow Google's current OAuth verification requirements for your audience and scopes. Publishing is not the same as verification and does not guarantee indefinite token validity. Google may require domain ownership, a public privacy policy, scope justification, and verification. Review [OAuth consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent) and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration). Do not bypass consent or verification warnings.

Local live development is separate from demo: set `APP_URL=http://localhost:3000`, configure `http://localhost:3000/auth/google/callback` as a Web OAuth redirect, set real secrets, and run `npm start`. Demo deliberately disables Google connection.

## VPS with Docker Compose and Caddy

This example assumes Docker Engine/Compose and Caddy are installed from their official sources on a Linux VPS. Run Caddy on the host, not in a separate container using `127.0.0.1` to reach Meetly. Configure DNS for your domain to the VPS and allow inbound TCP 80/443, with SSH limited appropriately. Keep port 3000 private. Review provider costs before provisioning.

1. Copy the project to the server and configure `.env` as above. Keep it out of version control. Set `DB_PATH=/app/data/meetly.sqlite` and your real HTTPS `APP_URL`.
2. Build and start:
   ```sh
   docker compose up -d --build
   docker compose ps
   curl -fsS http://127.0.0.1:3000/healthz
   ```
3. Add a Caddy site in your host's Caddyfile:
   ```caddyfile
   meet.example.com {
       reverse_proxy 127.0.0.1:3000 {
           header_up X-Forwarded-For {remote_host}
       }
   }
   ```
   This explicitly overwrites the forwarded address with Caddy's direct client address. For this topology, set `TRUST_PROXY=true` and recreate the app container with `docker compose up -d`. Do not place an additional CDN/proxy in front without reviewing the trusted-client-IP configuration.
4. Validate and reload Caddy using the service commands appropriate to your install, for example:
   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   curl -fsS https://meet.example.com/healthz
   ```
5. Visit `/admin`, configure your profile and Google account, and run the launch checklist below.

Compose stores data in the named `meetly-data` volume (Docker normally prefixes it with the Compose project name). Keep that project name stable across upgrades; changing it can create a different, empty volume. `docker compose down` normally preserves the volume. **Never use `docker compose down -v` unless intentionally destroying the database with a verified backup.**

## Alternative: persistent-disk host such as Render

Use a paid/service tier that supports a persistent disk and a continuously running web service, not a static site or ephemeral/free deployment. Provider support, prices, and plan restrictions can change.

- Deploy the Dockerfile as one web-service instance.
- Attach persistent disk at `/app/data`. Set `DB_PATH=/app/data/meetly.sqlite`.
- Set all secrets in the provider's secret environment settings, not in the repository or image.
- Use `PORT=3000` when supported by the provider's port routing. If the provider mandates another port, update the Docker health check accordingly.
- Set `APP_URL` to the final HTTPS custom domain or provider hostname. Add its exact Google callback URI before connecting.
- Configure health checks to `/healthz`; disable multiple replicas and autoscaling. Verify disk write permissions for the container's `node` user.
- Leave `TRUST_PROXY=false` until you have verified the provider's forwarding-header sanitization and direct-access restrictions. This can mean shared rate limits in the interim.
- Ensure deployment replacement preserves the same disk. Arrange consistent backups independently of deployment history.

## Launch checklist

- [ ] Public HTTPS works; `APP_URL` matches the browser origin exactly.
- [ ] `/admin` requires a strong private password; no demo banner is shown.
- [ ] Database survives a restart; backup and restore procedures are rehearsed.
- [ ] Google connection uses the correct account and destination calendar; selected conflict calendars are readable.
- [ ] Profile name, host timezone, weekly hours, notice, buffers, horizon, and event links are personalized.
- [ ] A real guest test creates exactly one event with the right attendee, time, and working Google Meet link. Optional ICS download/import is checked separately from invitation delivery.
- [ ] A busy event blocks the expected slot; browser retries do not create duplicate events.
- [ ] Admin cancellation removes the test event and requests attendee notification.
- [ ] Consent publishing/token expiry is understood; privacy and contact information are appropriate for your audience.
- [ ] Pending bookings and failed Meet creation have an owner who will review them.

This portable build has no fresh live Google or public-infrastructure verification. A separately hosted upstream variant completed a live event/Meet creation and cancellation test, but that does not validate this build or your OAuth configuration. See [Testing](TESTING.md). Run the launch checklist for every new deployment; local/mocked checks cannot establish consent, invitation delivery, or Meet account policies.
