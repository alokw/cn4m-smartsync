import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { config, configProblems } from './config.js';
import { log } from './log.js';
import { authorizeUrl, exchangeCode, authStatus } from './oauth.js';
import { listSheets, listReports } from './smartsheet.js';
import { stateStore, manualWatermark } from './store.js';
import { runSync } from './sync.js';
import { csvUrl, authMode, fetchRows, fetchRawRows, googleColumns } from './gsheet.js';
import { advanceWatermark } from './transform.js';
import { enabledFields } from './target.js';
import { recentEvents, eventCounts } from './events.js';

const pendingStates = new Set();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cn4m-smartsync</title><style>
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#666; --bg:#fdfdfd; --card:#fff; --line:#e3e3e3; --ok:#137333; --bad:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#999; --bg:#16181c; --card:#1e2126; --line:#31353b; --ok:#5bb974; --bad:#f2857c; } }
* { box-sizing:border-box; }
body { margin:0; padding:2.5rem 1.25rem; background:var(--bg); color:var(--fg);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:640px; margin:0 auto; }
h1 { font-size:1.3rem; margin:0 0 .25rem; letter-spacing:-.01em; }
h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:2rem 0 .6rem; }
.sub { color:var(--muted); margin:0 0 2rem; font-size:.9rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1rem 1.1rem; margin-bottom:.6rem; }
dl { display:grid; grid-template-columns:auto 1fr; gap:.45rem 1.1rem; margin:0; }
dt { color:var(--muted); }
dd { margin:0; word-break:break-word; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; background:color-mix(in srgb,var(--fg) 8%,transparent); padding:.1rem .35rem; border-radius:4px; }
.ok { color:var(--ok); font-weight:600; } .bad { color:var(--bad); font-weight:600; }
a.btn, button { display:inline-block; font:inherit; font-weight:550; padding:.6rem 1.1rem; border-radius:7px;
  border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; text-decoration:none; margin-right:.4rem; }
a.primary { background:var(--fg); color:var(--bg); border-color:var(--fg); }
ul { margin:.3rem 0; padding-left:1.2rem; } li { margin:.2rem 0; }
</style></head><body><main>${body}</main></body></html>`;
}

const LEVEL_COLOUR = { error: 'var(--bad)', warn: '#b26a00', info: 'var(--muted)', debug: 'var(--muted)' };

// "2026-09-03T21:43:23.048Z" -> "21:43:23" (or the date too, if not today)
function when(iso) {
  const today = new Date().toISOString().slice(0, 10);
  return iso.slice(0, 10) === today ? iso.slice(11, 19) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function activityFeed(events) {
  if (events.length === 0) return '<p style="margin:0;color:var(--muted)">Nothing yet.</p>';

  return `<div style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.9">${
    events.map((e) => `<div style="display:flex;gap:.7rem;align-items:baseline">
      <span style="color:var(--muted);white-space:nowrap">${esc(when(e.at))}</span>
      <span style="color:${LEVEL_COLOUR[e.level] ?? 'var(--muted)'};text-transform:uppercase;font-size:11px;width:3.2rem;flex:none">${esc(e.level)}</span>
      <span style="word-break:break-word">${esc(e.message)}</span>
    </div>`).join('')}</div>`;
}

async function statusPage() {
  const auth = await authStatus();
  const state = await stateStore.read();
  const problems = configProblems();
  const r = state.lastResult;

  const connected = auth.connected
    ? `<span class="ok">connected</span> <span style="color:var(--muted)">(${esc(auth.mode)})</span>`
    : '<span class="bad">not connected</span>';

  return page(`
    <h1>cn4m-smartsync</h1>
    <p class="sub">Google Sheet &rarr; Smartsheet, every ${config.syncIntervalSeconds}s
      &middot; <code>${esc(config.syncMode)}</code> mode${config.syncMode === 'reconcile'
        ? ' (all rows re-checked each pass; watermark only limits Discord)' : ' (only rows newer than the watermark)'}</p>

    ${problems.length ? `<div class="card"><strong class="bad">Configuration needed</strong><ul>${
      problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}

    <h2>Smartsheet</h2>
    <div class="card"><dl>
      <dt>Status</dt><dd>${connected}</dd>
      ${auth.expiresAt ? `<dt>Token expires</dt><dd>${esc(auth.expiresAt)}</dd>` : ''}
      <dt>Target</dt><dd>${config.smartsheet.reportId
        ? `report <code>${esc(config.smartsheet.reportId)}</code> <span style="color:var(--muted)">(row filter)</span>`
        : config.smartsheet.sheetId
          ? `sheet <code>${esc(config.smartsheet.sheetId)}</code>`
          : '<span class="bad">not set</span>'}</dd>
      <dt>Columns</dt><dd>match on <code>${esc(config.smartsheet.nameColumn)}</code> &rarr; ${
        enabledFields().length
          ? enabledFields().map((f) => `<code>${esc(config.smartsheet[`${f}Column`])}</code>`).join(', ')
          : '<span class="bad">no write columns configured</span>'}</dd>
    </dl></div>

    <h2>Source</h2>
    <div class="card"><dl>
      <dt>Google Sheet</dt><dd>${config.google.sheetId
        ? `<code>${esc(config.google.sheetId)}</code> gid <code>${esc(config.google.gid)}</code>`
        : '<span class="bad">not set</span>'}</dd>
      <dt>Source columns</dt><dd>${Object.entries(googleColumns())
        .map(([f, t]) => `<code>${esc(t)}</code>`).join(', ')} &middot; <a href="/columns">check</a></dd>
      <dt>Read via</dt><dd>${esc(authMode())}${authMode() === 'public CSV export'
        ? ` &middot; <a href="${esc(csvUrl())}">CSV</a> <span style="color:var(--muted)">(set GOOGLE_CREDS for private sheets)</span>` : ''}</dd>
      <dt>Watermark</dt><dd><code>${esc(state.watermark ?? 'unset')}</code></dd>
      <dt>Last run</dt><dd>${esc(state.lastRunAt ?? 'never')}</dd>
      <dt>Last result</dt><dd>${r ? `${r.newRows} new &middot; ${r.updated} updated &middot; ${r.unmatched} unmatched${r.ambiguous ? ` &middot; <span class="bad">${r.ambiguous} ambiguous</span>` : ''}${r.firstRun ? ' <em>(first run, nothing written)</em>' : ''}` : '&mdash;'}</dd>
      ${config.dryRun ? '<dt>Mode</dt><dd><span class="bad">DRY_RUN — no writes</span></dd>' : ''}
    </dl></div>

    <h2>Watermark</h2>
    <div class="card">
      <p style="margin:0 0 .8rem;color:var(--muted);font-size:.9rem">
        Currently <code>${esc(state.watermark ?? 'unset')}</code>. Rows processed
        at or before this are considered already handled.</p>
      <form method="post" action="/watermark?mode=skip" style="display:inline">
        <button type="submit">Skip to newest</button></form>
      <form method="post" action="/watermark?mode=arm" style="display:inline">
        <button type="submit">Reset (safe)</button></form>
      <form method="post" action="/watermark?mode=backfill" style="display:inline"
        onsubmit="return confirm('Re-sync EVERY row in the sheet on the next pass? This can write many Smartsheet rows and post many Discord messages.')">
        <button type="submit" style="border-color:var(--bad);color:var(--bad)">Backfill everything</button></form>
      <form method="post" action="/watermark" style="margin-top:.7rem;display:flex;gap:.4rem;flex-wrap:wrap">
        <input type="hidden" name="mode" value="set">
        <input name="value" required placeholder="2026-08-01 00:00:00" pattern="\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}"
          style="flex:1;min-width:12rem;font:inherit;padding:.55rem .7rem;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg)">
        <button type="submit">Set to&hellip;</button>
      </form>
    </div>

    <h2>Activity</h2>
    <div class="card">
      ${activityFeed(recentEvents({ limit: 12 }))}
      <p style="margin:.9rem 0 0;font-size:.85rem"><a href="/log">Full log &rarr;</a></p>
    </div>

    <h2>Actions</h2>
    <p>
      ${auth.connected
        ? '<a class="btn" href="/sheets">List my sheets</a>'
        : '<a class="btn primary" href="/authorize">Connect to Smartsheet</a>'}
      <a class="btn" href="/sync" onclick="this.textContent='Running…'">Run sync now</a>
      <a class="btn" href="/sync?force=1"
        onclick="return confirm('Force a sync, bypassing first-run protection?')">Run sync (force)</a>
      ${auth.connected ? '<a class="btn" href="/authorize">Reauthorize</a>' : ''}
    </p>

    <h2>Endpoints</h2>
    <div class="card"><dl>
      <dt><a href="/sheets">/sheets</a></dt><dd>reports and sheets, with their ids</dd>
      <dt><a href="/columns">/columns</a></dt><dd>Google Sheet headers vs the configured mapping</dd>
      <dt><a href="/sync">/sync</a></dt><dd>run a pass now &middot; <code>?force=1</code> bypasses first-run</dd>
      <dt><code>/watermark</code></dt><dd>POST only &middot; <code>?mode=skip|arm|set|backfill</code></dd>
      <dt><a href="/log">/log</a></dt><dd>recent activity &middot; <code>?all=1</code> includes per-pass detail</dd>
      <dt><a href="/health">/health</a></dt><dd>health check</dd>
    </dl></div>
  `);
}

function logPage(all) {
  const counts = eventCounts();
  const events = recentEvents({ limit: 200, notableOnly: !all });

  return page(`
    <h1>Activity</h1>
    <p class="sub">The last ${counts.total} log line(s) this process has produced,
      newest first. Held in memory only, so a restart starts the list again.</p>

    <p>
      <a class="btn${all ? '' : ' primary'}" href="/log">Notable (${counts.notable})</a>
      <a class="btn${all ? ' primary' : ''}" href="/log?all=1">Everything (${counts.total})</a>
    </p>

    <div class="card">${activityFeed(events)}</div>
    <p><a class="btn" href="/">&larr; Back</a></p>
  `);
}

async function columnsPage() {
  const raw = await fetchRawRows();
  const index = new Map(raw.headers.map((h) => [h.trim().toLowerCase(), h]));

  const rows = Object.entries(googleColumns()).map(([field, title]) => ({
    field,
    title,
    actual: index.get((title ?? '').trim().toLowerCase()) ?? null,
  }));

  const required = new Set(['NAME', 'PROCESSED']);

  return page(`
    <h1>Google Sheet columns</h1>
    <p class="sub">What the sync is looking for, against what the sheet actually
      has. Set these with <code>GOOGLE_*_COLUMN</code> in <code>.env</code>.</p>

    <h2>Mapping</h2>
    <div class="card"><dl>
      ${rows.map((r) => `<dt>${esc(r.field)}${required.has(r.field) ? '' : ' <span style="color:var(--muted)">(optional)</span>'}</dt>
        <dd>${r.actual
          ? `<code>${esc(r.actual)}</code> <span class="ok">found</span>`
          : `<code>${esc(r.title || '(unset)')}</code> <span class="bad">not found</span>`}</dd>`).join('')}
    </dl></div>

    <h2>Headers in the sheet (${raw.headers.length})</h2>
    <div class="card" style="line-height:2">${raw.headers.map((h) => `<code>${esc(h)}</code>`).join(' ')}</div>

    <p style="color:var(--muted);font-size:.9rem">${raw.records.length} data row(s).</p>
    <p><a class="btn" href="/">&larr; Back</a></p>
  `);
}

async function sheetsPage() {
  const [sheets, reports] = await Promise.all([listSheets(), listReports()]);

  const card = (item, envVar) => `<div class="card">
      <strong>${esc(item.name)}</strong><br>
      <code>${esc(item.id)}</code>
      <div style="color:var(--muted);font-size:.85rem;margin-top:.35rem">${envVar}=${esc(item.id)}</div>
    </div>`;

  return page(`
    <h1>Your Smartsheet targets</h1>
    <p class="sub">Copy one id into your <code>.env</code>, then
      <code>docker compose up -d --force-recreate</code>.</p>

    <h2>Reports</h2>
    <p class="sub" style="margin-bottom:.8rem">A report acts as a row filter: only rows visible in it are
      eligible to match, which keeps deprecated rows out. Takes priority over
      <code>SMARTSHEET_SHEET_ID</code> if both are set.</p>
    ${reports.length ? reports.map((r) => card(r, 'SMARTSHEET_REPORT_ID')).join('')
      : '<div class="card">No reports found.</div>'}

    <h2>Sheets</h2>
    <p class="sub" style="margin-bottom:.8rem">Matches against every row in the sheet.</p>
    ${sheets.length ? sheets.map((s) => card(s, 'SMARTSHEET_SHEET_ID')).join('')
      : '<div class="card">No sheets found.</div>'}

    <p><a class="btn" href="/">&larr; Back</a></p>
  `);
}

// Accepts parameters from the query string (handy for curl) or from a posted
// form body (used by the controls on the status page).
async function readParams(req, url) {
  const params = new URLSearchParams(url.search);
  if (req.method !== 'POST') return params;
  if (!(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return params;

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw new Error('request body too large');
    chunks.push(chunk);
  }

  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString())) {
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

async function handle(req, res, url) {
  switch (url.pathname) {
    case '/health':
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json');

    case '/': {
      return send(res, 200, await statusPage());
    }

    case '/authorize': {
      if (!config.smartsheet.clientId) {
        return send(res, 400, page('<h1>SMARTSHEET_CLIENT_ID is not set</h1><p><a href="/">Back</a></p>'));
      }
      const state = randomBytes(16).toString('hex');
      pendingStates.add(state);
      res.writeHead(302, { Location: authorizeUrl(state) });
      return res.end();
    }

    case '/callback': {
      const error = url.searchParams.get('error');
      if (error) {
        return send(res, 400, page(`<h1 class="bad">Authorization failed</h1><p><code>${esc(error)}</code></p><p><a class="btn" href="/">Back</a></p>`));
      }

      const state = url.searchParams.get('state');
      if (!state || !pendingStates.delete(state)) {
        return send(res, 400, page('<h1 class="bad">Invalid state</h1><p>Start the flow again from the home page.</p><p><a class="btn" href="/">Back</a></p>'));
      }

      const code = url.searchParams.get('code');
      if (!code) return send(res, 400, page('<h1 class="bad">No code returned</h1>'));

      await exchangeCode(code);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    case '/watermark': {
      if (req.method !== 'POST') {
        return send(res, 405, page(`<h1>Use POST</h1>
          <p>Watermark changes are POST-only so a stray link or prefetch cannot trigger one.</p>
          <div class="card"><code>curl -X POST 'http://localhost:${config.port}/watermark?mode=skip'</code></div>
          <p><a class="btn" href="/">&larr; Back</a></p>`));
      }

      const params = await readParams(req, url);
      const mode = params.get('mode') ?? '';
      const state = await stateStore.read();

      let next;
      try {
        if (mode === 'skip') {
          // Needs the sheet itself to know where "newest" is.
          const { records } = await fetchRows();
          next = { ...state, ...advanceWatermark(records, null), initialized: true };
        } else {
          next = manualWatermark(mode, state, params.get('value'));
        }
      } catch (err) {
        return send(res, 400, page(`<h1 class="bad">${esc(err.message)}</h1><p><a class="btn" href="/">&larr; Back</a></p>`));
      }

      await stateStore.write(next);
      log.event(`watermark ${mode}: ${state.watermark ?? 'unset'} -> ${next.watermark ?? 'unset'}`);

      if ((req.headers.accept ?? '').includes('application/json')) {
        return send(res, 200, JSON.stringify({ ok: true, mode, watermark: next.watermark }), 'application/json');
      }
      res.writeHead(303, { Location: '/' });
      return res.end();
    }

    case '/log':
      return send(res, 200, logPage(url.searchParams.get('all') === '1'));

    case '/columns':
      return send(res, 200, await columnsPage());

    case '/sheets':
      return send(res, 200, await sheetsPage());

    case '/sync': {
      const result = await runSync({ force: url.searchParams.get('force') === '1' });
      return send(res, 200, page(`
        <h1>Sync result</h1>
        <div class="card"><code>${esc(JSON.stringify(result, null, 2))}</code></div>
        <p><a class="btn" href="/">&larr; Back</a></p>`));
    }

    default:
      return send(res, 404, page('<h1>Not found</h1><p><a href="/">Home</a></p>'));
  }
}

export function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      await handle(req, res, url);
    } catch (err) {
      log.error(`request ${url.pathname} failed: ${err.message}`);
      if (!res.headersSent) {
        send(res, 500, page(`<h1 class="bad">Error</h1><p><code>${esc(err.message)}</code></p><p><a class="btn" href="/">Back</a></p>`));
      }
    }
  });

  server.listen(config.port, () => {
    log.info(`web UI on http://localhost:${config.port}`);
  });

  return server;
}
