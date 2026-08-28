import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { loadCredentials, buildAssertion } from '../src/google-auth.js';
import { toRecords } from '../src/gsheet.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const credsObject = {
  type: 'service_account',
  project_id: 'demo',
  client_email: 'sync@demo.iam.gserviceaccount.com',
  private_key: privateKey,
};
const credsJson = JSON.stringify(credsObject);

test('loadCredentials accepts the single-line JSON form', () => {
  const c = loadCredentials(credsJson);
  assert.equal(c.client_email, credsObject.client_email);
  assert.ok(c.private_key.includes('-----BEGIN PRIVATE KEY-----'));
});

test('loadCredentials accepts base64-encoded JSON', () => {
  const c = loadCredentials(Buffer.from(credsJson).toString('base64'));
  assert.equal(c.client_email, credsObject.client_email);
});

test('loadCredentials repairs a double-escaped private key', () => {
  const mangled = JSON.stringify({ ...credsObject, private_key: privateKey.replace(/\n/g, '\\n') });
  const c = loadCredentials(mangled);
  assert.ok(c.private_key.includes('-----BEGIN PRIVATE KEY-----\n'));
});

test('loadCredentials rejects junk and incomplete keys', () => {
  assert.throws(() => loadCredentials('not a key at all'), /neither JSON nor base64/);
  assert.throws(() => loadCredentials('{"client_email":"a@b.c"}'), /missing client_email or private_key/);
  assert.throws(() => loadCredentials('{oops'), /not valid JSON/);
});

test('buildAssertion produces a cryptographically valid RS256 JWT', () => {
  const creds = loadCredentials(credsJson);
  const [header, claims, signature] = buildAssertion(creds, 1000).split('.');

  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });

  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(payload.iss, credsObject.client_email);
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(payload.iat, 1000);
  assert.equal(payload.exp, 4600);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${claims}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), 'signature must verify against the public key');
});

test('toRecords handles the ragged rows the values API returns', () => {
  const { headers, records } = toRecords([
    ['NAME', 'VERSION', 'DURATION'],
    ['4020_D4Preshow_F', '☝️ v2', '00:17:39.067'],
    ['4360_OprahBG_G1', '🆕 v01'],   // trailing empty cell omitted by the API
    [],                              // blank row
    ['', '', ''],                    // all-empty row
  ]);

  assert.deepEqual(headers, ['NAME', 'VERSION', 'DURATION']);
  assert.equal(records.length, 2);
  assert.equal(records[1].DURATION, '', 'missing trailing cell becomes an empty string');
  assert.equal(records[0].VERSION, '☝️ v2');
});
