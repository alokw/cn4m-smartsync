# cn4m-smartsync

Watches a cn4m repo Google Sheet for newly-processed rows and pushes their
`VERSION` and `PROCESSED` values into Smartsheet, matching on `NAME`.
Rows with no Smartsheet match are reported to a Discord webhook.

Runs as a single Docker container: a sync loop plus a small web UI that handles
the one-time Smartsheet authorization.

## How it works

1. Every `SYNC_INTERVAL_SECONDS` it reads the Google Sheet tab.
2. Rows whose `PROCESSED` timestamp is newer than the stored watermark are new.
3. New rows are grouped by `NAME`, and each group is reduced to one set of
   values: the **highest `VERSION`** and the **latest `PROCESSED`**.
4. That `NAME` is looked up in the Smartsheet match column.
   - **One match** → `VERSION` and `PROCESSED` are written, but only if they differ.
   - **No match** → `FILENAME: no match found in smartsheet` goes to Discord.
   - **Several matches** → all are updated, and `NAME: matched N rows in
     smartsheet` goes to Discord.
5. The watermark advances only after a successful pass, so a failed run retries.

The Google Sheet is read through the Sheets API using a service account, so
private sheets work. If no credentials are configured it falls back to the
public CSV export, which only works for link-readable sheets.

## Setup

### 1. Register the Smartsheet app

In Smartsheet: **Account → Developer Tools → Create New App**.

| Field | Value |
| --- | --- |
| App URL | `https://github.com/<you>/cn4m-smartsync` |
| App redirect URL | `http://localhost:2646/callback` |

Smartsheet never fetches the App URL — it is just a profile link, so the repo
URL is fine and there is nothing to host. The redirect URL only has to match
what the container serves; the browser resolves `localhost` on your machine and
Docker forwards port 2646 into the container.

Copy the generated **client id** and **client secret**.

> Prefer to skip OAuth? Set `SMARTSHEET_ACCESS_TOKEN` to a personal API token
> (**Account → Personal Settings → API Access**) and the OAuth flow is bypassed
> entirely. Simpler, but the token is long-lived and unscoped.

### 2. Google credentials (service account)

The Sheets API reads through a service account, so private sheets work.

1. In [console.cloud.google.com](https://console.cloud.google.com), pick or create
   a project and enable the **Google Sheets API**.
2. **IAM & Admin → Service Accounts → Create service account.** No project roles
   are needed; access is granted per-spreadsheet in step 4.
3. On that account: **Keys → Add key → Create new key → JSON**. A file downloads.
4. Open the spreadsheet, **Share** it with the account's `client_email`
   (`something@project.iam.gserviceaccount.com`) as a **Viewer**.
5. Paste the key into `.env` on a single line:

```
GOOGLE_CREDS={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n","client_email":"sync@project.iam.gserviceaccount.com",...}
```

Two things to get right: the value must be on **one line** with no surrounding
quotes, and the `\n` sequences inside `private_key` must stay as the two
characters `\` and `n` — do not turn them into real line breaks. That is exactly
how they appear in the downloaded file, so a straight copy-paste is correct.

If pasting the key inline is awkward, either of these works instead:

```
GOOGLE_CREDS=<base64 of the same JSON>     # base64 -i key.json | tr -d '\n'
GOOGLE_CREDS_FILE=/data/gcp-key.json       # drop the file into ./data
```

Only the `spreadsheets.readonly` scope is requested. Leave all three blank to
fall back to the public CSV export.

### 3. Configure

```bash
cp .env.example .env   # already done for you if you cloned this working copy
```

Fill in `SMARTSHEET_CLIENT_ID`, `SMARTSHEET_CLIENT_SECRET` and
`DISCORD_WEBHOOK_URL`. Leave `SMARTSHEET_REPORT_ID` and `SMARTSHEET_SHEET_ID`
blank for now — step 5 looks their ids up for you.

### 4. Start it

```bash
docker compose up -d --build
```

Open <http://localhost:2646>, click **Connect to Smartsheet**, approve. The
tokens land in `./data/tokens.json` and refresh themselves from then on — you
should not need to authorize again.

### 5. Point it at a report or a sheet

Click **List my sheets** to see both. Copy one id into `.env`, then
`docker compose up -d --force-recreate`.

**A report (recommended)** acts as a *row filter*:

```
SMARTSHEET_REPORT_ID=292156844494724
```

Only rows visible in the report are eligible to match, so deprecated or
out-of-scope rows sitting in the underlying sheet are never touched. Columns are
still resolved against the *source sheet*, which means the report does not have
to display the columns being written — a report showing `Naming Convention (FD)`
can still drive a write to `Duration (OBX)`.

Reports spanning several source sheets work too; writes are grouped per sheet.

**A sheet** matches against every row it contains:

```
SMARTSHEET_SHEET_ID=257795587788676
```

If both are set, the report wins.

Set the column titles to match your target:

```
SMARTSHEET_NAME_COLUMN=Naming Convention (FD)
SMARTSHEET_VERSION_COLUMN=Version (OBX)
SMARTSHEET_PROCESSED_COLUMN=Received (OBX)
SMARTSHEET_DURATION_COLUMN=
```

Titles containing spaces or parentheses need no quoting in `.env`.

### 6. First run

The first pass writes nothing. Every existing row predates today, so treating
them as new would fire hundreds of Discord messages. Instead it records where
the sheet stands and syncs only rows processed after that point.

To backfill the existing rows anyway, visit <http://localhost:2646/sync?force=1>.
Try it with `DRY_RUN=true` first to see what it would do.

## Configuration

All settings live in `.env`. The ones worth knowing:

| Variable | Default | Notes |
| --- | --- | --- |
| `SYNC_INTERVAL_SECONDS` | `60` | Minimum 10. |
| `SYNC_MODE` | `reconcile` | `reconcile` or `watermark` — see below. |
| `SMARTSHEET_NAME_COLUMN` | `NAME` | Match key. Matching is case-insensitive. |
| `SMARTSHEET_VERSION_COLUMN` | `VERSION` | Written on match. Blank disables it. |
| `SMARTSHEET_PROCESSED_COLUMN` | `PROCESSED` | Written on match. Blank disables it. |
| `SMARTSHEET_DURATION_COLUMN` | *(blank)* | Off. Set a title to re-enable. |
| `SMARTSHEET_MISC_COLUMN` | *(blank)* | Composite, built from `GOOGLE_MISC_TEMPLATE`. |
| `SKIP_BLANK_VALUES` | `true` | Never blank a Smartsheet cell because the source is empty. |
| `DRY_RUN` | `false` | Log intended changes, write nothing. |

Smartsheet column titles are matched case-insensitively; if one is missing, the
error names every column the sheet actually has.

### Google Sheet source columns

Which columns to read from. Also matched case-insensitively, so a renamed source
column is an `.env` change rather than a code change.

| Variable | Default | Notes |
| --- | --- | --- |
| `GOOGLE_SHEET_ID` | — | From the sheet URL. |
| `GOOGLE_SHEET_GID` | `0` | The tab, from `#gid=` in the URL. |
| `GOOGLE_SHEET_TAB` | *(blank)* | Address the tab by title instead of gid. |
| `GOOGLE_NAME_COLUMN` | `NAME` | **Required.** Matched against the Smartsheet match column. |
| `GOOGLE_PROCESSED_COLUMN` | `PROCESSED` | **Required.** Decides which rows are new. |
| `GOOGLE_VERSION_COLUMN` | `VERSION` | Optional. |
| `GOOGLE_DURATION_COLUMN` | `DURATION` | Optional, and only used if the Smartsheet duration column is set. |
| `GOOGLE_FILENAME_COLUMN` | `FILENAME` | Optional. Used in the Discord no-match message, and in `GOOGLE_MISC_TEMPLATE`. |
| `GOOGLE_MISC_TEMPLATE` | `[{DURATION}][, {FILENAME}]` | Composite written to `SMARTSHEET_MISC_COLUMN`. |

A missing **required** column stops the sync with an error listing every header
the sheet actually has. A missing optional one only warns, and that field stays
empty. **<http://localhost:2646/columns> shows this mapping checked against the
live sheet** — the quickest way to diagnose a naming mismatch.

### Optional overrides

| Variable | Default | Notes |
| --- | --- | --- |
| `SMARTSHEET_SCOPES` | `READ_SHEETS WRITE_SHEETS` | Changing this needs a reauthorize. |
| `DATA_DIR` | `/data` in the container | Where `tokens.json` and `state.json` live. |

Leave both unset. In particular, an empty `DATA_DIR=` line is *not* the same as
omitting it — it overrides the container's `/data` and moves the tokens off the
mounted volume, losing them on the next rebuild.

## Sync modes

**`reconcile`** (default) treats the sync as a reconciliation loop. Every pass
matches *all* rows and writes any cell that differs, so a row can never be
permanently missed by a stale read, a failed pass or a backdated edit. Writes are
diffed, so a pass with nothing to do writes nothing — a full pass over a few
hundred rows costs about two seconds and three API calls.

The watermark is then used only to decide what may raise a **Discord message**,
so a permanently-unmatched file is announced once rather than every pass.

**`watermark`** is the older behaviour: only rows processed after the watermark
are looked at at all. Cheaper, but anything missed stays missed.

| | `reconcile` | `watermark` |
| --- | --- | --- |
| Rows examined per pass | all | only newer than the watermark |
| Recovers a missed row | yes, next pass | no |
| Smartsheet reads per pass | 2 | 2, only when new rows exist |
| Discord messages | new rows only | new rows only |

The trade-off: `reconcile` makes the Google Sheet **continuously authoritative**.
A manual edit to a synced Smartsheet cell is reverted within one interval, where
under `watermark` it would survive until a new source row appeared.
`SKIP_BLANK_VALUES=true` still stops a blank source cell blanking a populated one.

> On a first run both modes write nothing and simply record where the sheet
> stands. In `reconcile` the next pass then writes any outstanding differences
> silently — pre-existing unmatched rows are not announced, because they are not
> newer than the watermark. Use `POST /watermark?mode=backfill` first if you do
> want that initial report.

## Data handling

- **`VERSION`** arrives as `☝️ v2` / `🆕 v001_hapaudio`. The first underscore and
  everything after it is dropped: suffixes like `_hapaudio`, `_30fps` and `_b`
  are encoding variants of the same version, not higher versions. So
  `🆕 v001_30fps_b` → `🆕 v001`. A suffix without an underscore is kept as part of
  the version (`v000n` stays `v000n`). The leading emoji is ignored when ranking
  versions but kept on the value written to Smartsheet.
- **`PROCESSED`** is normalised to `YYYY-MM-DD HH:MM:SS` before writing.
- **`DURATION`** is currently switched off (`SMARTSHEET_DURATION_COLUMN=`). When
  enabled it passes both shapes through untouched — timecode (`00:03:00:00`) and
  milliseconds (`00:17:39.067`).
- **Unchanged cells are never written**, so a 60s loop does not churn the
  Smartsheet modification history.
- **Duplicate `NAME`s** in Smartsheet are *all* updated — picking one silently
  would be a quiet data bug. Each is logged and reported to Discord, since one
  source row writing to several Smartsheet rows is usually worth knowing about.

### Several Google rows, one NAME

A `NAME` often appears on more than one row — different screens, or a
re-process. Rows are grouped by `NAME` and **each column is reduced across the
group independently**:

| Column | Rule |
| --- | --- |
| `VERSION` | Underscore suffix stripped, then the highest by natural ordering: `v2` > `v01`, `v10` > `v9`, `v001` > `v000n` |
| `PROCESSED` | Latest timestamp |
| `DURATION` | Value from the latest-processed row (when enabled) |

Because they are reduced independently, the version written and the timestamp
written can come from *different* rows. That is deliberate: the newest timestamp
records when the asset was last touched, while the highest version records the
best cut available.

## Operating

```bash
docker compose logs -f                   # follow
docker compose up -d --force-recreate    # pick up .env changes
docker compose up -d --build             # pick up CODE changes
docker compose down                      # stop
npm test                                 # unit tests, no credentials needed

# ...or run the tests without a local node install:
docker run --rm -v "$PWD:/app" -w /app node:22-alpine node --test 'test/*.test.js'
```

> **`.env` changes need a recreate. Code changes need a rebuild.** These are two
> different things, and only one of them carries the source:
>
> | You changed | Command | Why |
> | --- | --- | --- |
> | `.env` | `docker compose up -d --force-recreate` | Compose reads `env_file` when it *creates* the container, so `docker compose restart` reuses the old environment. |
> | `src/` | `docker compose up -d --build` | The Dockerfile bakes `src/` into the image. Without `--build`, Compose reuses the existing image, so a freshly recreated container happily runs old code. |
>
> Editing both and then only recreating is the confusing case: the new settings
> load into a process whose logic knows nothing about them, which reads as the
> config being silently ignored. `--build` covers both, so prefer it when unsure.

### Deploying a code change

Run `docker compose up -d --build`, then read the line the sync loop logs on boot:

```
INFO  writing columns: version, processed, status, notes, format, audio, misc
```

That list is built from whichever `SMARTSHEET_*_COLUMN` titles are set, so it is
the fastest proof that the new code *and* the new config are both live. A column
you just configured missing from that list means the build did not take.

It syncs **on boot** — the first pass runs before the first
`SYNC_INTERVAL_SECONDS` wait — so there is no need to sit out the interval. In
`reconcile` mode that pass reconsiders every row rather than only rows newer than
the watermark, so a newly enabled column backfills across the whole sheet at
once. Expect `updated` in the `sync complete` line to jump on that first pass and
fall back to `0` afterwards, since unchanged cells are never rewritten.

To look before you leap:

```bash
DRY_RUN=true docker compose up -d --build    # logs every intended change, writes nothing
curl 'http://localhost:2646/sync?force=1'    # run a pass now instead of waiting
```

A missing Smartsheet column fails loudly rather than skipping quietly: the error
names every column title the sheet actually has. Titles match case-insensitively,
so only a real spelling difference bites.

### Is the container running what I think it is?

```bash
docker ps --filter name=cn4m-smartsync --format '{{.Image}} | {{.Status}}'
docker image ls | grep smartsync                              # image age
docker exec cn4m-smartsync grep -c misc /app/src/target.js    # 0 = stale code
docker exec cn4m-smartsync printenv | grep SMARTSHEET_        # what the process really sees
```

For the third one, swap `misc` for any symbol from the change you are chasing.
A container created two minutes ago can still be running a two-day-old image —
its age tells you nothing about the code inside it.

State lives in `./data` (mounted into the container):

- `tokens.json` — OAuth tokens. Delete to force reauthorization.
- `state.json` — the watermark. Delete to reset to first-run behaviour.

Both are gitignored. `tokens.json` is written `0600`.

### Endpoints

| Path | Purpose |
| --- | --- |
| `/` | Status: connection, watermark, last result |
| `/authorize` | Start (or redo) the OAuth flow |
| `/callback` | OAuth redirect target — registered on the app, not visited directly |
| `/sheets` | List your reports and sheets, with their ids |
| `/columns` | Google Sheet headers vs the configured mapping |
| `/sync` | Run a pass immediately (`?force=1` to bypass first-run) |
| `/watermark` | Move the watermark. **POST only** — see below |
| `/health` | Health check |

## Resetting the watermark

The watermark is what makes a row "new". Buttons for this sit on the status page
under **Watermark**, or drive it over HTTP. It is `POST` only, deliberately: a
reset can trigger a large number of Smartsheet writes and Discord messages, and
`GET` is reachable by a browser prefetch or a stray click.

```bash
curl -X POST 'http://localhost:2646/watermark?mode=skip'
```

| Mode | Effect | Next pass will |
| --- | --- | --- |
| `skip` | Jump to the newest row currently in the sheet | Sync only rows processed from now on |
| `arm` | Clear it and re-arm first-run protection | Write nothing, just re-record where the sheet stands |
| `set` | Set an explicit `YYYY-MM-DD HH:MM:SS` | Sync everything processed after that moment |
| `backfill` | Clear it outright | **Re-sync every row in the sheet** |

```bash
curl -X POST 'http://localhost:2646/watermark?mode=set&value=2026-08-01%2000:00:00'
curl -X POST -H 'Accept: application/json' 'http://localhost:2646/watermark?mode=skip'
```

`skip` and `arm` both stop existing rows from re-syncing; the difference is that
`arm` also restores the first-run behaviour, so the next pass re-records the
position instead of acting on it. Prefer `arm` when unsure.

`backfill` is the destructive one — every row becomes new again. The UI asks for
confirmation. Try it with `DRY_RUN=true` first.

An invalid mode or timestamp returns `400` and leaves the watermark alone. Add
`Accept: application/json` for a JSON response instead of a redirect.

Deleting `data/state.json` is equivalent to `arm`.

## Known limits

- The watermark only moves forward. A row backdated to *before* the current
  watermark is not picked up — clear `state.json` to rescan.
- Rows with an unparseable `PROCESSED` are skipped, since there is no way to
  tell whether they are new.
