import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

let cached = null;

const b64url = (input) => Buffer.from(input).toString('base64url');

// Accepts the service account key as raw JSON (the documented route), as base64,
// or as a path to a mounted file. Pasting raw JSON into .env is fussy enough
// that the alternatives are worth having.
export function loadCredentials(rawOverride) {
  let raw = rawOverride ?? (config.google.credsFile
    ? readFileSync(config.google.credsFile, 'utf8')
    : config.google.creds);

  if (!raw) return null;
  raw = raw.trim();

  if (!raw.startsWith('{')) {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
    if (!decoded.startsWith('{')) {
      throw new Error('GOOGLE_CREDS is neither JSON nor base64-encoded JSON');
    }
    raw = decoded;
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GOOGLE_CREDS is not valid JSON: ${err.message}`);
  }

  if (!creds.client_email || !creds.private_key) {
    throw new Error('GOOGLE_CREDS is missing client_email or private_key');
  }

  // Survives a key whose newlines were escaped a second time on the way in.
  creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return creds;
}

export function serviceAccountEmail() {
  try {
    return loadCredentials()?.client_email ?? null;
  } catch {
    return null;
  }
}

// Signed JWT bearer assertion -- the service account flow, RFC 7523.
export function buildAssertion(creds, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(creds.private_key, 'base64url')}`;
}

// Null means "no credentials configured", which the caller treats as a signal
// to fall back to the public CSV export.
export async function getGoogleAccessToken() {
  const creds = loadCredentials();
  if (!creds) return null;

  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(creds),
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Google token request failed (${res.status}): ${body}`);
  }

  const json = JSON.parse(body);
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  log.debug(`obtained Google access token for ${creds.client_email}`);
  return cached.token;
}
