---
name: job-search-tracker
description: >-
  Query, search, and manage Singapore IT job listings in the local SQLite
  tracker (`data/jobs.db`). Use when the user asks "what are the new jobs",
  "check new jobs", "list saved/applied jobs", "search for jobs", "update job
  status", "job stats", or "discover job boards".
---

# Job Search Tracker

Use the project CLI (`src/cli.ts`) to inspect, search, and update job listings stored in `data/jobs.db`.

> **Important:** Invoke the CLI with `node --import tsx src/cli.ts ...` rather than `npm run dev -- ...`, because `npm` strips `--status`, `--limit`, and other `--flag` arguments before passing them to `tsx`.

## Workflows

### 1. Check New Jobs ("what are the new jobs")

1. Check overall counts and recent scrape runs:
   ```powershell
   node --import tsx src/cli.ts stats
   ```
2. List jobs with `status = new` (set `--limit` high enough to cover the `new` count from `stats`):
   ```powershell
   node --import tsx src/cli.ts list --status new --limit 150
   ```
   Optional filters: `--source <id>`, `--search <text>`, `--db <path>`.
3. Summarize the results for the user:
   - Total `new` count broken down by `source` and latest `last_seen` timestamp.
   - Highlight the most recently posted roles (with ID, title, company, salary, and posted time).
   - Offer to filter by keyword/salary/source or update statuses.

### 2. Run a Fresh Job Search

Search across configured sources and upsert results into `data/jobs.db`:

```powershell
node --import tsx src/cli.ts search --query "Java" --limit 50
```

- Optional: `--sources <comma-separated-ids>` (run `node --import tsx src/cli.ts --help` to see registered sources and aliases).
- Note: Live scraping makes outbound network requests and may require running outside the sandbox (`BypassSandbox: true`) if network access is blocked.

### 3. Update Job Status & Notes

Valid statuses: `new`, `saved`, `applied`, `interviewing`, `rejected`, `archived`.

```powershell
node --import tsx src/cli.ts update --id 25 --status saved --notes "Strong match"
```

### 4. Discover ATS Boards

Probe Greenhouse/Lever boards for Singapore-active roles:

```powershell
node --import tsx src/cli.ts discover --tokens gh:company,lv:company
```

Or pass `--url <page-url>` and/or `--boards <path>`.
