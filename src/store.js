import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { normalizeProcessed } from './transform.js';

const TOKEN_FILE = () => join(config.dataDir, 'tokens.json');
const STATE_FILE = () => join(config.dataDir, 'state.json');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`could not read ${path}: ${err.message}`);
    return fallback;
  }
}

// Write to a temp file then rename, so a crash mid-write cannot leave a
// half-written token file behind and lock us out.
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export const tokenStore = {
  read: () => readJson(TOKEN_FILE(), null),
  write: (tokens) => writeJson(TOKEN_FILE(), tokens),
};

const EMPTY_STATE = {
  initialized: false,
  watermark: null,        // highest PROCESSED value already accounted for
  seenAtWatermark: [],    // fingerprints of rows sharing that exact timestamp
  lastRunAt: null,
  lastResult: null,
};

export const stateStore = {
  async read() {
    return { ...EMPTY_STATE, ...(await readJson(STATE_FILE(), {})) };
  },
  write: (state) => writeJson(STATE_FILE(), state),
};

// Manual watermark overrides. "skip" is handled by the caller, which needs the
// sheet contents to work out where the newest row is.
export function manualWatermark(mode, state, value) {
  const base = { ...state, seenAtWatermark: [] };

  switch (mode) {
    // Everything looks new again -> the next pass re-syncs the whole sheet.
    case 'backfill':
      return { ...base, watermark: null, initialized: true };

    // Safe reset: the next pass only re-records where the sheet stands.
    case 'arm':
      return { ...base, watermark: null, initialized: false };

    case 'set': {
      const watermark = normalizeProcessed(value);
      if (!watermark) {
        throw new Error(`"${value ?? ''}" is not a valid timestamp (expected YYYY-MM-DD HH:MM:SS)`);
      }
      return { ...base, watermark, initialized: true };
    }

    default:
      throw new Error(`unknown mode "${mode}" (expected backfill, arm, skip or set)`);
  }
}
