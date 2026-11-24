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
- **Incremental LLM Project Review**:
  - Reviews only recent listings with missing or invalidated assessments, preserving valid results and application tracking.
  - Stores the inferred domain, confidence, exact listing evidence, reasoning, reviewer model and analysis timestamp.
  - Generates a final HTML report containing all recent persisted assessments across all application statuses without a row limit.

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
# Scrape Java, C#, .NET, and Python and write a preliminary 7-day HTML report
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

# Generate a report of recent jobs with status new
node --import tsx src/cli.ts report --status new --days 7

# Filter a report by source and keyword
node --import tsx src/cli.ts report --source mcf --search "Python" --days 7

# Export only recent jobs with missing or invalidated assessments for LLM review
node --import tsx src/cli.ts analyze --days 7 --out data/reports/llm-review-input.json

# Save completed LLM decisions and generate a report from the stored results
node --import tsx src/cli.ts analyze --input data/reports/llm-project-review.json

# Discover and validate more Singapore ATS company boards into config/boards.json
node --import tsx src/cli.ts discover
node --import tsx src/cli.ts discover --url "https://raw.githubusercontent.com/..."
node --import tsx src/cli.ts discover --tokens "gh:company1,lv:company2"
```

### Complete Agent Workflow

Ask the workspace agent: `Use Skill: job-search-tracker run full`.
The agent completes scraping, pending-job export, individual LLM review,
validated import and final report generation automatically.
The CLI `full` command itself only scrapes and creates a preliminary report;
it does not invoke an LLM.

To carry out the same workflow manually:

1. Run `node --import tsx src/cli.ts full`.
2. Export pending jobs with `node --import tsx src/cli.ts analyze --days 7 --out data/reports/llm-review-input.json`.
3. Have an LLM assess every exported listing individually and save its completed decisions to `data/reports/llm-project-review.json`.
4. Import with `node --import tsx src/cli.ts analyze --input data/reports/llm-project-review.json`.
5. Verify that the import succeeds and its updated count equals the exported pending count. Use the report generated by the import as the final result.

Keep the input and review JSON files for audit. If no jobs need review, import
an empty `decisions` array with the actual reviewer model and exported metadata
to generate the final report while preserving existing assessments.

`full` defaults to 50 results per source and keyword and a seven-day window.
It accepts `--query`, `--sources`, `--limit`, `--days`, `--db` and `--out`.
Carry any custom `--days` and `--db` into the export, and the custom `--db`
and final HTML `--out` into the import. The import uses the review's
`snapshotAt` and `days`; an import-time `--days` does not override them.

The preliminary report filters `new` jobs, uses posted dates and reads at most
500 records before date filtering. The final import report covers all recent
jobs across all statuses without a row limit, using posted dates with a
last-seen fallback when unavailable. These reports can therefore have different
job counts. Reports are saved as timestamped HTML files in `data/reports/`
unless `--out` supplies a different path.

Source blocks or partial scrape failures do not prevent review of available
database listings. Check the per-source results even when `full` exits
successfully: blocked sources can appear alongside successful searches.
HTTP 429 indicates rate limiting and incomplete coverage for that search.

### Assessment Rules

Project analysis uses LLM decisions, with no keyword classifier or automatic confidence scoring.
The exported input contains `snapshotAt`, `days`, and each job's `id`, `input_hash`,
`title`, `company`, and `description`. The completed review must contain `model`,
the same `snapshotAt` and `days`, and a `decisions` array covering every exported pending job.
Each decision supplies `id`, `input_hash`, `label`, `score` (an integer 0–100, or `null` for
`Unclear`), an exact source quote in `evidence`, and `reasoning`.
The importer validates complete coverage, unchanged input, quotes and score ranges
before writing in one transaction. It updates only pending records and preserves
every valid existing assessment, including its model and analysis timestamp.
Validity requires LLM method, a valid timestamp, nonempty model, label and reasoning,
an exact source quote, and a valid score (including `Unclear` with `null`).
Pending membership is rechecked at import; an intervening scrape or review can require
a fresh export. An empty review is accepted only when no pending jobs remain.
The final report includes all recent records, both preserved and newly assessed.
It records the model and method with each new result.
Percentages express subjective confidence in the named project domain, not calibrated
probabilities. New jobs and jobs whose title, employer or description changes await
another LLM review; scraping alone does not invoke a model. Reports show pending
results as `Not analyzed`.

Use `Unclear` with a null score when stored listing text does not establish a
domain, particularly for recruiter listings with generic or missing descriptions.
Do not infer private banking from banking technology or wealth management alone,
or a government-agency project from a government-linked employer. Keep core
banking, private banking, wealth management, public healthcare and education
distinct where the evidence supports them.

---

## Latest Completed Run

Snapshot: **24 November 2026**, default Java, C#, .NET and Python searches.
The search added **26 new listings**, bringing the database to **636 jobs**,
all currently with status `new`. The validated review updated **27 pending
assessments** and preserved **484 valid assessments**. The final seven-day
report contains **511 recent jobs**; 13 of the newly reviewed listings are
`Unclear`, and 14 have supported domain labels.

| Source | Jobs with status `new` | Latest seen (UTC) |
|---|---:|---|
| JobStreet | 394 | 2026-11-24 04:43:06 |
| MyCareersFuture | 231 | 2026-11-24 04:43:17 |
| Greenhouse | 11 | 2026-11-24 04:42:37 |
| Lever | 0 | No stored listings |

JobStreet's .NET and Python searches were blocked by HTTP 429. Its Java and C#
searches succeeded, as did the other configured sources; Lever returned no
matching listings.

Local run artifacts (generated data is gitignored and may be absent in a fresh checkout):

- [Final persisted-assessment report](data/reports/jobs-2026-11-24_12-44-25.html)
- [Pending review input](data/reports/llm-review-input.json)
- [Completed LLM review](data/reports/llm-project-review.json)

The default JSON paths are reused by subsequent runs; the timestamped HTML
report identifies this snapshot. Run `stats` for current database counts.

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
│   ├── jobs.db                         # SQLite database (auto-created, gitignored)
│   └── reports/                        # Timestamped HTML reports and review JSON
├── src/
│   ├── cli.ts                          # CLI entrypoint and command dispatch
│   ├── cli/
│   │   ├── args.ts                     # Argument parsing, defaults and validation
│   │   └── commands.ts                 # full, search, list, report, analyze, update, stats, discover
│   ├── runner.ts                       # Fault-isolated search runner & run logger
│   ├── db/
│   │   ├── schema.sql                  # DDL for jobs & scrape_runs tables
│   │   ├── client.ts                   # SQLite connection, upserts, queries, assessment validity
│   │   └── project-analysis.ts         # Recent/pending scope and transactional review import
│   ├── report/
│   │   ├── html.ts                     # Report generation and posted-date parsing
│   │   └── template.html               # HTML report layout
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
    ├── cli-args.test.ts                # CLI argument and workflow tests
    ├── db.test.ts                      # In-memory SQLite, runner, and registry tests
    ├── normalizer.test.ts              # Payload normalizer, salary parser, and discovery tests
    └── report.test.ts                  # HTML rendering and date filtering tests
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
