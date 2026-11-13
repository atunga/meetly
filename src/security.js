import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function encrypt(text, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
export function decrypt(value, key) {
  const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export function passwordVerifier(password) {
  const salt = randomBytes(16), expected = scryptSync(password, salt, 64);
  return input => {
    if (typeof input !== 'string' || input.length > 512) return false;
    return timingSafeEqual(expected, scryptSync(input, salt, 64));
  };
}
export class HttpError extends Error { constructor(status, message, code = 'request_error') { super(message); this.status = status; this.code = code; } }
export function sameOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin || origin !== config.appUrl) throw new HttpError(403, 'This request must come from the booking website.', 'origin_mismatch');
}
export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(a => a.length === 2));
}
export function textValue(value, field, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new HttpError(400, `Check ${field}.`);
  return value.trim();
}
export function validEmail(value) {
  const result = textValue(value, 'email', 3, 254).toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(result)) throw new HttpError(400, 'Enter a valid email address.');
  return result;
}
