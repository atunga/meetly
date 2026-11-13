import { randomBytes } from 'node:crypto';
console.log('Add these to your private .env or hosting secrets. Never commit them.\n');
console.log(`ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`);
console.log(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
