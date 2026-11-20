---
name: job-search-tracker
description: >-
  Query, search, and manage Singapore IT job listings in the local SQLite
  tracker (`data/jobs.db`). Use when the user asks "run full", "full job
  search", "what are the new jobs", "check new jobs", "list saved/applied
  jobs", "search for jobs", "update job status", "job stats", or "discover job
  boards".
version: 1.2.0
---

# Job Search Tracker

Use the project CLI (`src/cli.ts`) to inspect, search, and update job listings stored in `data/jobs.db`.

> **Important:** Invoke the CLI with `node --import tsx src/cli.ts ...` rather than `npm run dev -- ...`, because `npm` strips `--status`, `--limit`, and other `--flag` arguments before passing them to `tsx`.

## Workflows

### 1. Run Full ("run full" / "full job search")

Single-command pipeline (searches all sources, prints status/source stats + recent runs, and generates the 7-day HTML report):

```powershell
node --import tsx src/cli.ts full
```

- Optional flags: `--query "Java"`, `--limit 50`, `--days 7`, `--sources <list>`, `--out <path>`, `--db <path>`.
- Live scraping requires outbound network access (`BypassSandbox: true` if sandbox blocks network).
- Do not run `--help`, `package.json` checks, or ad-hoc SQLite/PowerShell queries.
- Verify exit code `0` and `Report generated (... jobs): <path>`, then reply concisely with the scrape summary, `Jobs by source` counts (`new_count` + `latest_last_seen`), and a clickable `file:///` link to the HTML report.

### 2. Check New Jobs ("what are the new jobs")

1. Check overall counts and recent scrape runs, and generate the timestamped HTML report (in parallel):
   ```powershell
   node --import tsx src/cli.ts stats
   node --import tsx src/cli.ts report --status new --days 7
   ```
   Optional report filters: `--source <id>`, `--search <text>`, `--limit 500`, `--out <path>`, `--db <path>`.
   (For raw JSON in scripts, use `node --import tsx src/cli.ts list --status new --limit 150 --json`; timestamp field is `last_seen_at`.)
2. Reply concisely with:
   - Total count by status, `Jobs by source` (`new_count` + `latest_last_seen`), and latest scrape run summary from `stats`.
   - A clickable `file:///` link to the generated HTML report (e.g. `data/reports/jobs-YYYY-MM-DD_HH-mm-ss.html`).
   - Offer to filter by keyword/salary/source or update statuses.

### 3. Run a Fresh Job Search

Search across configured sources and upsert results into `data/jobs.db`:

```powershell
node --import tsx src/cli.ts search --query "Java" --limit 50
```

- Optional: `--sources <comma-separated-ids>` (registered sources: `greenhouse`/`gh`, `lever`/`lv`, `mycareersfuture`/`mcf`, `jobstreet`/`js`).
- Live scraping makes outbound network requests and requires `BypassSandbox: true` if blocked by the sandbox.

### 4. Update Job Status & Notes

Valid statuses: `new`, `saved`, `applied`, `interviewing`, `rejected`, `archived`.

```powershell
node --import tsx src/cli.ts update --id 25 --status saved --notes "Strong match"
```

### 5. Discover ATS Boards

Probe Greenhouse/Lever boards for Singapore-active roles:

```powershell
node --import tsx src/cli.ts discover --tokens gh:company,lv:company
```

Or pass `--url <page-url>` and/or `--boards <path>`.
