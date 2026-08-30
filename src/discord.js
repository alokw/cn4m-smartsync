import { config } from './config.js';
import { log } from './log.js';

const MAX_MESSAGE_CHARS = 1900;   // Discord's hard limit is 2000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Packs lines into the fewest messages that stay under the limit. A single
// oversized line is truncated rather than silently rejected by Discord.
export function batchLines(lines, max = MAX_MESSAGE_CHARS) {
  const batches = [];
  let batch = [];
  let length = 0;

  for (const raw of lines) {
    const line = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;

    if (batch.length && length + line.length + 1 > max) {
      batches.push(batch.join('\n'));
      batch = [];
      length = 0;
    }
    batch.push(line);
    length += line.length + 1;
  }

  if (batch.length) batches.push(batch.join('\n'));
  return batches;
}

export const unmatchedLines = (filenames) =>
  filenames.map((f) => `**${f}**: no match found in smartsheet`);

export const multipleMatchLines = (entries) =>
  entries.map(({ name, count }) => `**${name}**: matched ${count} rows in smartsheet, all updated`);

export const lockedLines = (entries) =>
  entries.map(({ name, count }) =>
    `**${name}**: matched ${count} locked row${count === 1 ? '' : 's'} in smartsheet, not updated`);

// Enough of the error to identify it without pushing the message over Discord's
// limit -- a Smartsheet 403 body is long, and the useful part is at the front.
const MAX_DETAIL_CHARS = 1500;

const detail = (message) =>
  message.length > MAX_DETAIL_CHARS ? `${message.slice(0, MAX_DETAIL_CHARS - 1)}…` : message;

// "2026-08-28T19:55:42.657Z" -> "2026-08-28 19:55:42 UTC"
const stamp = (iso) => `${iso.replace('T', ' ').slice(0, 19)} UTC`;

// A broken sync retries on every tick, so an alert per tick would have sent ~36
// messages during the three hours a locked row stalled the loop. The repeat
// alert therefore leads with the duration and the attempt count.
export function failureLines({ message, since, count }) {
  const lead = count > 1
    ? `⚠️ **sync still failing** — ${count} attempts since ${stamp(since)}`
    : `⚠️ **sync failed**`;
  return [`${lead}
\`\`\`
${detail(message)}
\`\`\``];
}

export const recoveryLines = ({ since, count }) =>
  [`✅ **sync recovered** — back to normal after ${count} failed attempt${count === 1 ? '' : 's'} since ${stamp(since)}`];

async function post(content) {
  const res = await fetch(config.discord.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 2);
    log.warn(`Discord rate limited, waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return post(content);
  }

  if (!res.ok) {
    throw new Error(`Discord webhook failed (${res.status}): ${await res.text()}`);
  }
}

// Grouped into as few messages as possible rather than one ping per row.
async function deliver(lines, what) {
  if (lines.length === 0) return;

  if (!config.discord.webhookUrl) {
    log.warn(`no DISCORD_WEBHOOK_URL set, ${lines.length} ${what} not reported`);
    return;
  }

  for (const content of batchLines(lines)) await post(content);
  log.info(`reported ${lines.length} ${what} to Discord`);
}

export const notifyUnmatched = (filenames) => deliver(unmatchedLines(filenames), 'unmatched row(s)');
export const notifyMultipleMatches = (entries) => deliver(multipleMatchLines(entries), 'ambiguous match(es)');
export const notifyLocked = (entries) => deliver(lockedLines(entries), 'locked row(s)');

// Alerting must never be able to break the loop it is reporting on: a webhook
// outage during an outage would otherwise replace the real error with its own.
async function tell(lines, what) {
  try {
    await deliver(lines, what);
  } catch (err) {
    log.warn(`could not report ${what} to Discord: ${err.message}`);
  }
}

export const notifyFailure = (failure) => tell(failureLines(failure), 'sync failure');
export const notifyRecovery = (failure) => tell(recoveryLines(failure), 'sync recovery');
