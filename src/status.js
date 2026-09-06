import { existsSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';

// Matches symmetry: one line per piece of news, never a heartbeat.
//
//   POST http://<cn4m-host>:2640/suite/status
//   app=smartsync&message=Synced+5+items+to+smartsheet&level=working

const TIMEOUT_MS = 5000;

// Doubling from a minute to a half-hour ceiling, matching symmetry's notify.py.
// A cn4m that is unset, wrong, or down should cost one attempt and one log line,
// not a failed request on every pass forever.
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 1_800_000;

export function backoffMs(failures) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (Math.max(failures, 1) - 1));
}

// Only news is worth sending, so a pass that changed nothing stays quiet.
export function syncMessage(result) {
  if (!result?.ok || result.dryRun || result.firstRun) return null;
  if (!result.updated) return null;

  const items = `${result.updated} item${result.updated === 1 ? '' : 's'}`;
  const extra = [];
  if (result.unmatched) extra.push(`${result.unmatched} unmatched`);
  if (result.locked) extra.push(`${result.locked} locked`);

  return `Synced ${items} to smartsheet${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

const isLocalhost = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url);
const inContainer = () => existsSync('/.dockerenv');

// Inside Docker, localhost is the container itself. Saying so beats reporting a
// bare connection refused and leaving someone to work it out.
function hint() {
  if (!inContainer() || !isLocalhost(config.status.url)) return '';
  return ' Note: inside a container, localhost is the container itself, not the machine'
    + ' running Docker. If cn4m runs on the host, use'
    + ' http://host.docker.internal:2640/suite/status; if it is another container, use'
    + ' its service name.';
}

class HttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP ${status}`);
    this.status = status;
    this.statusText = statusText;
  }
}

let failures = 0;
let mutedUntil = 0;
let warned = false;
const inFlight = new Set();

async function send(message, level) {
  const body = new URLSearchParams({ app: config.status.app, message, level });

  try {
    const res = await fetch(config.status.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Drain the body so the socket can be reused rather than left hanging.
    await res.arrayBuffer().catch(() => {});

    // An HTTP error backs off exactly like a refused connection: a 404 means
    // this cn4m does not have the endpoint, and retrying it every pass is noise.
    if (!res.ok) throw new HttpError(res.status, res.statusText);

    failures = 0;
    mutedUntil = 0;
    if (warned) {
      warned = false;
      log.info(`status endpoint ${config.status.url} is reachable again`);
    }
    log.debug(`pushed status: ${message}`);
  } catch (err) {
    failures++;
    const wait = backoffMs(failures);
    mutedUntil = Date.now() + wait;

    const reason = err instanceof HttpError
      ? `responded ${err.status}${err.statusText ? ` ${err.statusText}` : ''}`
      : `is unreachable (${err.message})`;

    if (warned) {
      log.debug(`status endpoint ${config.status.url} ${reason} (failure ${failures}, next try in ${wait / 1000}s)`);
    } else {
      warned = true;
      log.warn(`status endpoint ${config.status.url} ${reason} -- pausing updates for ${wait / 1000}s,`
        + ` then retrying with a longer gap each time.${hint()}`);
    }
  }
}

// Fire and forget. A cn4m that is slow, down, or absent must never delay or
// interrupt a sync, so nothing here is awaited by the caller and every error is
// swallowed into a log line.
export function statusUpdate(message, level = 'working') {
  if (!config.status.url || !message) return;

  if (Date.now() < mutedUntil) {
    const waiting = Math.round((mutedUntil - Date.now()) / 1000);
    log.debug(`skipping status update: ${config.status.url} has failed ${failures} time(s), next try in ${waiting}s`);
    return;
  }

  const pending = send(message, level).finally(() => inFlight.delete(pending));
  inFlight.add(pending);
}

// Gives in-flight updates a moment on shutdown, which is what makes the update
// from the last pass before `docker stop` actually arrive.
export async function flushStatus(ms = TIMEOUT_MS + 1000) {
  if (inFlight.size === 0) return;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

// Tests only.
export function resetStatus() {
  failures = 0;
  mutedUntil = 0;
  warned = false;
  inFlight.clear();
}
