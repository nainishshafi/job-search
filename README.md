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

Run via `npm run dev -- <command>` (TypeScript via `tsx`) or `node dist/cli.js <command>` (compiled JS):

```powershell
# Search all registered sources (gh, lv, mcf, js)
npm run dev -- search --query "Java" --limit 50

# Search specific sources
npm run dev -- search --query "Backend Engineer" --sources mcf,jobstreet --limit 25

# List tracked jobs (filter by status, source, or keyword)
npm run dev -- list --status new --limit 25
npm run dev -- list --source mcf --search "Lead"

# Update application status and notes
npm run dev -- update --id 1 --status applied --notes "Applied via portal"

# View status counts and recent scrape runs
npm run dev -- stats

# Discover and validate more Singapore ATS company boards into config/boards.json
npm run dev -- discover
npm run dev -- discover --url "https://raw.githubusercontent.com/..."
npm run dev -- discover --tokens "gh:company1,lv:company2"
```

---

## Project Structure

```text
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
