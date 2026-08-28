// Pure helpers shared by the sync loop and the tests.

const PROCESSED_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;

// PROCESSED looks like "2026-06-18 14:55:34". Normalising to a fixed
// "YYYY-MM-DD HH:MM:SS" shape means plain string comparison is also
// chronological, which sidesteps every timezone question.
export function normalizeProcessed(raw) {
  const m = PROCESSED_RE.exec((raw ?? '').trim());
  return m ? `${m[1]} ${m[2]}` : null;
}

// VERSION arrives as "☝️ v2" / "🆕 v001_hapaudio". Drop the leading emoji, then
// drop the first underscore and everything after it: suffixes like _hapaudio,
// _30fps and _b are encoding variants of the same version, not higher versions,
// so "v001_hapaudio" and "v001_30fps_b" both reduce to "v001".
export function normalizeVersion(raw) {
  if (!raw) return '';
  return raw.replace(/^[^\p{L}\p{N}]+/u, '').trim().split('_')[0];
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
export function highestVersion(rows) {
  let best = '';
  for (const row of rows) {
    const v = normalizeVersion(row.VERSION);
    if (v && (best === '' || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

export function highestProcessed(rows) {
  let best = '';
  for (const row of rows) {
    const p = normalizeProcessed(row.PROCESSED);
    if (p && (best === '' || p > best)) best = p;
  }
  return best;
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
    const processed = highestProcessed(rows);
    // Only VERSION and PROCESSED have a meaningful "highest". Everything else
    // describes a particular file, so it comes from the latest-processed row.
    const latest = rows.find((r) => normalizeProcessed(r.PROCESSED) === processed) ?? rows[0];

    out.set(key, {
      rows,
      values: {
        version: highestVersion(rows),
        processed,
        duration: normalizeDuration(latest.DURATION),
        status: String(latest.STATUS ?? '').trim(),
        notes: String(latest.NOTES ?? '').trim(),
        format: renderTemplate(templates.format, latest),
        audio: renderTemplate(templates.audio, latest),
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
