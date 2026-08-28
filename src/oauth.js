import { config } from './config.js';
import { log } from './log.js';
import { tokenStore } from './store.js';

const AUTHORIZE_URL = 'https://app.smartsheet.com/b/authorize';
const TOKEN_URL = 'https://api.smartsheet.com/2.0/token';

// Refresh a little early so a long sync never runs off the end of a token.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.smartsheet.clientId,
    scope: config.smartsheet.scopes,
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

// Smartsheet takes these as a form body, and does not use redirect_uri here --
// it uses whatever redirect URL is registered on the app itself.
async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Smartsheet token request failed (${res.status}): ${body}`);
  }

  const json = JSON.parse(body);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    // expires_in is seconds (~604799, about 7 days).
    expiresAt: Date.now() + (json.expires_in ?? 604799) * 1000,
    obtainedAt: new Date().toISOString(),
  };
}

export async function exchangeCode(code) {
  const tokens = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: config.smartsheet.clientId,
    client_secret: config.smartsheet.clientSecret,
  });
  await tokenStore.write(tokens);
  log.info('OAuth authorization complete, tokens stored');
  return tokens;
}

export async function refresh(tokens) {
  const next = await postToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: config.smartsheet.clientId,
    client_secret: config.smartsheet.clientSecret,
  });
  // Smartsheet returns a fresh refresh token; keep the old one only if it did not.
  next.refreshToken ??= tokens.refreshToken;
  await tokenStore.write(next);
  log.info('Smartsheet access token refreshed');
  return next;
}

// Returns a usable bearer token, refreshing if needed. Null means "not connected yet".
export async function getAccessToken() {
  if (config.smartsheet.accessToken) return config.smartsheet.accessToken;

  const tokens = await tokenStore.read();
  if (!tokens?.accessToken) return null;

  if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) return tokens.accessToken;

  if (!tokens.refreshToken) {
    log.warn('Access token expired and no refresh token is stored -- reauthorize at /');
    return null;
  }

  const refreshed = await refresh(tokens);
  return refreshed.accessToken;
}

export async function authStatus() {
  if (config.smartsheet.accessToken) {
    return { connected: true, mode: 'personal access token', expiresAt: null };
  }
  const tokens = await tokenStore.read();
  if (!tokens?.accessToken) return { connected: false, mode: 'oauth', expiresAt: null };
  return { connected: true, mode: 'oauth', expiresAt: new Date(tokens.expiresAt).toISOString() };
}
