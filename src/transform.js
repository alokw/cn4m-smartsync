// Pure helpers shared by the sync loop and the tests.

const PROCESSED_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;

// PROCESSED looks like "2026-06-18 14:55:34". Normalising to a fixed
// "YYYY-MM-DD HH:MM:SS" shape means plain string comparison is also
// chronological, which sidesteps every timezone question.
export function normalizeProcessed(raw) {
  const m = PROCESSED_RE.exec((raw ?? '').trim());
  return m ? `${m[1]} ${m[2]}` : null;
}

// VERSION arrives as "☝️ v2" / "🆕 v001_hapaudio". This is the *comparison
// key*: drop the leading emoji, then drop the first underscore and everything
// after it. Suffixes like _hapaudio, _30fps and _b are encoding variants of the
// same version, not higher versions, so "v001_hapaudio" and "v001_30fps_b" both
// reduce to "v001". The emoji is only dropped for ordering -- see displayVersion.
export function normalizeVersion(raw) {
  if (!raw) return '';
  return raw.replace(/^[^\p{L}\p{N}]+/u, '').trim().split('_')[0];
}

// The emoji (or whatever other non-alphanumeric run) sits in front of the version.
export function versionPrefix(raw) {
  const m = /^[^\p{L}\p{N}]+/u.exec((raw ?? '').trim());
  return m ? m[0].trim() : '';
}

// What is actually written to Smartsheet: the underscore suffix gone, but the
// leading emoji put back, so "🆕 v001_hapaudio" writes as "🆕 v001".
export function displayVersion(raw) {
  const core = normalizeVersion(raw);
  if (!core) return '';
  const prefix = versionPrefix(raw);
  return prefix ? `${prefix} ${core}` : core;
}

// DURATION is either a timecode ("00:03:00:00") or ms ("00:17:39.067").
// Both are meaningful, so pass them through untouched.
export function normalizeDuration(raw) {
  return (raw ?? '').trim();
}

export function normalizeName(raw) {
  return (raw ?? '').trim().toLowerCase();
}

// Identifies a specific row-state, so a row is not re-applied on the next pass
// but IS re-applied if its VERSION or DURATION actually changed.
export function fingerprint(row) {
  return [row.NAME, row.FILENAME, row.VERSION, row.DURATION].map((v) => (v ?? '').trim()).join('|');
}

// Rows are "new" if they were processed after the watermark, or at exactly the
// watermark second but were not among the rows already handled then. Without
// the tie-break, a row written in the same second as the watermark is lost.
export function selectNewRows(records, state) {
  const seen = new Set(state.seenAtWatermark ?? []);
  const out = [];

  for (const row of records) {
    const processed = normalizeProcessed(row.PROCESSED);
    if (!processed) continue;

    if (state.watermark === null) { out.push({ row, processed }); continue; }
    if (processed > state.watermark) { out.push({ row, processed }); continue; }
    if (processed === state.watermark && !seen.has(fingerprint(row))) out.push({ row, processed });
  }

  return out;
}

// The new watermark is the highest PROCESSED we have now accounted for, along
// with every row sharing that timestamp.
export function advanceWatermark(records, previous) {
  let max = previous;

  for (const row of records) {
    const processed = normalizeProcessed(row.PROCESSED);
    if (processed && (max === null || processed > max)) max = processed;
  }

  if (max === null) return { watermark: previous, seenAtWatermark: [] };

  const seenAtWatermark = records
    .filter((row) => normalizeProcessed(row.PROCESSED) === max)
    .map(fingerprint);

  return { watermark: max, seenAtWatermark };
}

// Natural ordering so v2 > v01 and v10 > v9: digit runs compare numerically,
// everything else lexicographically (v0b > v0a, v001 > v000n). Underscore
// variants never reach here -- normalizeVersion has already stripped them.
export function compareVersions(a, b) {
  const chunks = (s) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
  const ca = chunks(a);
  const cb = chunks(b);

  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    if (/^\d/.test(x) && /^\d/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// A NAME can appear on several Google Sheet rows (different screens, or a
// re-process). Each field is reduced across the whole group independently.
// Compares on the normalized key, but returns the winning row's display form so
// its emoji survives into Smartsheet.
export function highestVersion(rows) {
  let best = '';
  let display = '';
  for (const row of rows) {
    const v = normalizeVersion(row.VERSION);
    if (v && (best === '' || compareVersions(v, best) > 0)) {
      best = v;
      display = displayVersion(row.VERSION);
    }
  }
  return display;
}

export function highestProcessed(rows) {
  let best = '';
  for (const row of rows) {
    const p = normalizeProcessed(row.PROCESSED);
    if (p && (best === '' || p > best)) best = p;
  }
  return best;
}

// A NAME covers several files: the graded movie, a stripped audio stem, a still
// export. Extensions decide which is which, so the deliverable can be told apart
// from the ancillary assets produced alongside it.
const KINDS = {
  mov: 'video', mp4: 'video', mxf: 'video', m4v: 'video', avi: 'video', mkv: 'video', webm: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', tif: 'image', tiff: 'image', exr: 'image', dpx: 'image', webp: 'image',
  wav: 'audio', aif: 'audio', aiff: 'audio', mp3: 'audio', aac: 'audio', flac: 'audio', m4a: 'audio',
};

// An unrecognised extension sits above audio, not below it: a stem is known to
// be ancillary, whereas an unfamiliar format might well be the deliverable.
const KIND_RANK = { video: 3, image: 2, other: 1, audio: 0 };

export function mediaKind(filename) {
  const name = String(filename ?? '').trim().toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return KINDS[ext] ?? 'other';
}

// WIDTH x HEIGHT, used to prefer the full-size render over a 16x16 proxy.
// Anything unparseable counts as zero so it loses to a row that has real ones.
export function pixelCount(row) {
  const side = (v) => {
    const n = Number.parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return side(row.WIDTH) * side(row.HEIGHT);
}

// "v002_hapaudio" is an encoding variant of v002, not a version of its own.
const isVariant = (version) => String(version ?? '').includes('_');

// Ranks two rows already known to share a version.
function compareTiebreak(a, b) {
  const plain = (isVariant(b.VERSION) ? 1 : 0) - (isVariant(a.VERSION) ? 1 : 0);
  if (plain !== 0) return plain;

  const kind = KIND_RANK[mediaKind(a.FILENAME)] - KIND_RANK[mediaKind(b.FILENAME)];
  if (kind !== 0) return kind;

  const pixels = pixelCount(a) - pixelCount(b);
  if (pixels !== 0) return pixels > 0 ? 1 : -1;

  const ap = normalizeProcessed(a.PROCESSED) ?? '';
  const bp = normalizeProcessed(b.PROCESSED) ?? '';
  if (ap !== bp) return ap > bp ? 1 : -1;
  return 0;
}

// Picks the row whose values describe the asset anyone actually cares about.
//
// Every field except VERSION and PROCESSED describes one specific file, and this
// used to take them from the latest-processed row -- which handed the whole group
// to whichever ancillary export happened to finish last, typically the audio stem
// stripped out after the movie was done.
//
// Highest VERSION still decides first. Within that version, in order: a plain
// version beats an encoding variant (v002 over v002_hapaudio), video beats stills
// beats audio, the larger frame beats a proxy, and only then the latest
// timestamp. Ties keep the earlier row, so the order is stable.
export function pickRepresentative(rows) {
  if (rows.length === 0) return undefined;

  const top = normalizeVersion(highestVersion(rows));
  const contenders = top ? rows.filter((row) => normalizeVersion(row.VERSION) === top) : rows;

  return contenders.reduce((best, row) => (compareTiebreak(best, row) >= 0 ? best : row));
}

// Groups new rows by NAME and reduces each group to the values to write.
export function aggregateByName(candidates, templates = {}) {
  const groups = new Map();

  for (const { row } of candidates) {
    const key = normalizeName(row.NAME);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = new Map();
  for (const [key, rows] of groups) {
    // Only PROCESSED has a meaningful "highest" across the whole group -- it
    // records when the asset was last touched, whichever file did the touching.
    // Everything else describes one particular file, so it all comes from the
    // one representative row rather than from several rows at once.
    const best = pickRepresentative(rows);

    out.set(key, {
      rows,
      values: {
        version: displayVersion(best.VERSION),
        processed: highestProcessed(rows),
        duration: normalizeDuration(best.DURATION),
        status: String(best.STATUS ?? '').trim(),
        notes: String(best.NOTES ?? '').trim(),
        format: renderTemplate(templates.format, best),
        audio: renderTemplate(templates.audio, best),
        misc: renderTemplate(templates.misc, best),
      },
    });
  }
  return out;
}

// Splits "what to sync" from "what to announce".
//
// In reconcile mode every row is a candidate for writing -- writes are diffed
// and idempotent, so re-examining everything costs nothing when it is already
// correct -- but only rows newer than the watermark may raise a Discord
// message, which is what stops a permanently-unmatched file pinging forever.
//
// In watermark mode both sets are the same, so behaviour is unchanged.
export function selectForSync(records, state, mode) {
  const fresh = selectNewRows(records, state);
  if (mode !== 'reconcile') return { candidates: fresh, notifiable: null };

  return {
    candidates: records.map((row) => ({ row })),
    notifiable: new Set(fresh.map((c) => fingerprint(c.row))),
  };
}

// Builds a composite value from several source columns.
//
//   [{CODEC}][, {WIDTH} x {HEIGHT}][ @ {FPS}]
//
// {COL} is replaced by that column's value (case-insensitive). A [...] segment
// is dropped whole if ANY placeholder inside it is blank, which is what keeps a
// still -- no CODEC, no FPS, no audio at all -- from rendering ", 6912 x 3840 @ ".
// Leftover leading/trailing separators are trimmed, and a result with no real
// content at all comes back empty so SKIP_BLANK_VALUES leaves the cell alone.
export function renderTemplate(template, row) {
  if (!template) return '';

  const lookup = new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const get = (key) => String(lookup.get(key.trim().toLowerCase()) ?? '').trim();
  const fill = (text) => text.replace(/\{([^{}]+)\}/g, (_, key) => get(key));

  const withSegments = template.replace(/\[([^\[\]]*)\]/g, (_, segment) => {
    const keys = [...segment.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
    return keys.some((k) => get(k) === '') ? '' : fill(segment);
  });

  const out = fill(withSegments)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,@\s]+/, '')
    .replace(/[,@\s]+$/, '');

  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}
