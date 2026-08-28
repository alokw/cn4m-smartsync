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
