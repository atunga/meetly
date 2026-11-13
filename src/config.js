import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { isTimezone } from './time.js';
import { validEmail } from './security.js';
export function loadConfig(env = process.env, argv = process.argv) {
  const demo = argv.includes('--demo') || env.DEMO_MODE === 'true';
  const production = env.NODE_ENV === 'production';
  if (demo && production) throw new Error('Demo mode is local-only. Remove NODE_ENV=production to run the demo.');
  const argument = name => { const index=argv.indexOf(name); return index>=0?argv[index+1]:undefined; };
  const port = Number(argument('--port') || env.PORT || 3000);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('PORT must be between 1 and 65535.');
  const previewHost=argument('--host');
  const localHost=['127.0.0.1','localhost'].includes(previewHost)?previewHost:'localhost';
  const appUrl = new URL(env.APP_URL || `http://${localHost}:${port}`);
  if (!['https:', 'http:'].includes(appUrl.protocol)) throw new Error('APP_URL must use HTTP or HTTPS.');
  if (appUrl.pathname !== '/' || appUrl.search || appUrl.hash || appUrl.username || appUrl.password) throw new Error('APP_URL must be an origin, e.g. https://meet.example.com');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname);
  if (!local && appUrl.protocol !== 'https:') throw new Error('Use HTTPS for a public APP_URL.');
  if (demo && !local) throw new Error('Demo mode can only use a localhost APP_URL.');
  const password = env.ADMIN_PASSWORD || (demo ? 'meetly-demo-only' : '');
  if (password.length < 16 || password.length > 512) throw new Error('Set ADMIN_PASSWORD to 16–512 characters. Run npm run secrets.');
  if (!demo && password === 'meetly-demo-only') throw new Error('The public demo password cannot be used for a real deployment. Run npm run secrets.');
  const key = env.TOKEN_ENCRYPTION_KEY || (demo ? randomBytes(32).toString('hex') : '');
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Set TOKEN_ENCRYPTION_KEY to 64 hexadecimal characters.');
  const hostName = (env.HOST_NAME || (demo ? 'Demo Host' : '')).trim();
  if (!hostName || hostName.length > 80 || /[\x00-\x1f\x7f]/.test(hostName)) throw new Error('Set HOST_NAME to your display name (1–80 characters).');
  const hostTimezone = env.HOST_TIMEZONE || 'UTC';
  if (!isTimezone(hostTimezone)) throw new Error('Set HOST_TIMEZONE to an IANA timezone such as America/New_York or Europe/London.');
  const suppliedEmail = env.HOST_EMAIL || env.OWNER_GOOGLE_EMAIL || (demo ? 'host@example.com' : '');
  let hostEmail;
  try { hostEmail = validEmail(suppliedEmail); } catch { throw new Error('Set HOST_EMAIL to the Google account that will own your calendar.'); }
  if (env.HOST_EMAIL && env.OWNER_GOOGLE_EMAIL && env.HOST_EMAIL.trim().toLowerCase() !== env.OWNER_GOOGLE_EMAIL.trim().toLowerCase()) throw new Error('HOST_EMAIL and legacy OWNER_GOOGLE_EMAIL must match when both are set.');
  const bind = argument('--host') || env.HOST || (demo || appUrl.protocol==='http:' ? '127.0.0.1' : '0.0.0.0');
  if (demo && !['127.0.0.1', 'localhost', '::1'].includes(bind)) throw new Error('Demo mode must bind to a loopback address.');
  return { demo, production, port, appUrl: appUrl.origin, secure: appUrl.protocol === 'https:',
    bind,
    dbPath: demo ? ':memory:' : resolve(env.DB_PATH || './data/meetly.sqlite'),
    password, encryptionKey: Buffer.from(key, 'hex'),
    googleClientId: env.GOOGLE_CLIENT_ID || '', googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    hostName, hostTimezone, ownerGoogleEmail: hostEmail,
    trustProxy: env.TRUST_PROXY === 'true',
  };
}
