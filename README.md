# Singapore IT Job Search & SQLite Tracker

A modular TypeScript CLI for searching IT jobs in Singapore using an **API-first** approach with **Playwright** browser fallback and local **SQLite** tracking (`data/jobs.db`).

---

## Features

- **API-First + Playwright Fallback**:
  - **Greenhouse (`gh`) & Lever (`lv`)**: Queries public ATS JSON APIs for Singapore-active companies configured in `config/boards.json`.
  - **MyCareersFuture SG (`mcf`)**: Uses the `POST /v2/search` JSON endpoint, automatically falling back to Playwright response interception if direct `fetch` is blocked or times out.
  - **JobStreet SG (`js`)**: Uses Playwright (headed by default; set `PW_HEADLESS=true` for headless) with polite anti-bot/CAPTCHA detection (`status: 'blocked'` without bypassing).
- **Idempotent SQLite Tracking (`data/jobs.db`)**:
  - Deduplicates listings via `UNIQUE(source, external_id)`.
  - Re-runs refresh metadata and `last_seen_at` while preserving your `status` (`new`, `saved`, `applied`, `interviewing`, `rejected`, `archived`) and `notes`.
  - Incremental pagination stops early when a page contains only already-tracked jobs.
- **Extensible Plugin Registry**:
  - All job boards implement `JobSourcePlugin` and register in one place (`src/sources/registry.ts`).
- **ATS Board Discovery (`discover`)**:
  - Extracts and validates new Singapore-active Greenhouse/Lever company boards from Hacker News comments, a URL, or explicit tokens and merges them into `config/boards.json`.

---

## Prerequisites

- **Node.js 22+**
- **Playwright Chromium** (required for `jobstreet` and the `mycareersfuture` Playwright fallback)

---

## Setup

```powershell
npm install
npx playwright install chromium
npm run build
```

---

## CLI Usage

Run via `node --import tsx src/cli.ts <command>` (TypeScript via `tsx`) or `node dist/cli.js <command>` (compiled JS):

> **Note:** Avoid `npm run dev -- <command> --flag ...` because `npm` strips `--flag` options before forwarding arguments to `tsx`.

```powershell
# Search Java, C#, .NET, and Python across all registered sources and write one 7-day HTML report
node --import tsx src/cli.ts full

# Override the default keyword list and run one search before generating the report
node --import tsx src/cli.ts full --query "Python"

# Search all registered sources (gh, lv, mcf, js)
node --import tsx src/cli.ts search --query "Java" --limit 50

# Search specific sources
node --import tsx src/cli.ts search --query "Backend Engineer" --sources mcf,jobstreet --limit 25

# List tracked jobs (filter by status, source, or keyword)
node --import tsx src/cli.ts list --status new --limit 25
node --import tsx src/cli.ts list --source mcf --search "Lead"

# Update application status and notes
node --import tsx src/cli.ts update --id 1 --status applied --notes "Applied via portal"

# View status counts and recent scrape runs
node --import tsx src/cli.ts stats

# Discover and validate more Singapore ATS company boards into config/boards.json
node --import tsx src/cli.ts discover
node --import tsx src/cli.ts discover --url "https://raw.githubusercontent.com/..."
node --import tsx src/cli.ts discover --tokens "gh:company1,lv:company2"
```

---

## Project Structure

```text
├── .agents/
│   └── skills/
│       └── job-search-tracker/
│           └── SKILL.md                # Workspace agent skill for querying & updating jobs
├── AGENTS.md                           # Project instructions for AI coding agents
├── config/
│   └── boards.json                     # Externalized Greenhouse & Lever company tokens
├── data/
│   └── jobs.db                         # SQLite database (auto-created, gitignored)
├── src/
│   ├── cli.ts                          # CLI entrypoint (search, list, update, stats, discover)
│   ├── runner.ts                       # Fault-isolated search runner & run logger
│   ├── db/
│   │   ├── schema.sql                  # DDL for jobs & scrape_runs tables
│   │   └── client.ts                   # SQLite connection, upserts, queries, stats
│   └── sources/
│       ├── types.ts                    # JobListing, SearchOptions, JobSourcePlugin contracts
│       ├── registry.ts                 # Central SOURCE_REGISTRY (add new boards here)
│       ├── api/
│       │   ├── ats.ts                  # Greenhouse & Lever adapters + board config loader
│       │   ├── discover.ts             # ATS board token discovery & validation
│       │   └── mycareersfuture.ts      # MyCareersFuture API + Playwright fallback
│       └── playwright/
│           ├── browser.ts              # Shared Playwright launcher & anti-bot detector
│           └── jobstreet.ts            # JobStreet SG Playwright adapter
└── tests/
    ├── db.test.ts                      # In-memory SQLite, runner, and registry tests
    └── normalizer.test.ts              # Payload normalizer, salary parser, and discovery tests
```

---

## Adding a New Job Board

1. Create an adapter file under `src/sources/` exporting a `JobSourcePlugin`:
   ```ts
   export const myBoardSource: JobSourcePlugin = {
     id: 'myboard',
     aliases: ['mb'],
     label: 'My Board SG',
     fetch: fetchMyBoardJobs,
   };
   ```
2. Add `myBoardSource` to `SOURCE_REGISTRY` in `src/sources/registry.ts`.

No edits to `types.ts`, `runner.ts`, or `cli.ts` are required.

---

## Development & Testing

```powershell
npm run typecheck
npm test
npm run build
```
