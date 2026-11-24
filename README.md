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
- **Company Web Research**:
  - The agent web-searches pending employers for company information, Glassdoor reviews and founders for small or unknown-size companies.
  - Stores cited findings, search queries, identity checks, model and research date in `jobs.company_research_json`.
  - Shares valid research across exact-name employer listings and shows a compact preview with full details in a modal.

---

## Prerequisites

- **Node.js 22+**
- **Playwright Chromium** (required for `jobstreet`, the `mycareersfuture` fallback, and company page retrieval)

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

# Export pending employers for actual LLM web searches
node --import tsx src/cli.ts research --days 7 --out data/reports/company-research-input.json

# Export a specific employer using its exact stored name
node --import tsx src/cli.ts research --company "EXACT STORED EMPLOYER NAME" --days 7

# Import cited company findings and generate the final combined report
node --import tsx src/cli.ts research --input data/reports/company-research-review.json

# Read a discovered company page with Playwright when direct requests are blocked
node --import tsx src/cli.ts research --url "https://example.com/company-information" --out data/reports/company-page-evidence.json

# Discover and validate more Singapore ATS company boards into config/boards.json
node --import tsx src/cli.ts discover
node --import tsx src/cli.ts discover --url "https://raw.githubusercontent.com/..."
node --import tsx src/cli.ts discover --tokens "gh:company1,lv:company2"
```

### Complete Agent Workflow

Ask the workspace agent: `Use Skill: job-search-tracker run full`.
The agent completes scraping, pending-job export, individual LLM review,
validated project import, pending-company web research and company import
with final report generation automatically.
The CLI `full` command itself only scrapes and creates a preliminary report;
it does not invoke an LLM.

The required stage order is:

**Scrape → project review → project import → company research → company import → verification → final report delivery**

The agent continues through every stage without separate confirmation. Project
review covers every pending listing; company research covers every pending
employer independently. Valid results are preserved. When company pages are
blocked or require JavaScript, the research stage uses Playwright and records
any remaining access restrictions.

To carry out the same workflow manually:

1. Run `node --import tsx src/cli.ts full`.
2. Export pending jobs with `node --import tsx src/cli.ts analyze --days 7 --out data/reports/llm-review-input.json`.
3. Have an LLM assess every exported listing individually and save its completed decisions to `data/reports/llm-project-review.json`.
4. Import with `node --import tsx src/cli.ts analyze --input data/reports/llm-project-review.json`.
5. Verify that project updates equal the exported pending job count.
6. Export pending companies with `node --import tsx src/cli.ts research --days 7 --out data/reports/company-research-input.json`.
7. Have the LLM actually web-search every exported employer, check Glassdoor and search for founders of small or unknown-size companies, then save cited decisions to `data/reports/company-research-review.json`.
8. Import with `node --import tsx src/cli.ts research --input data/reports/company-research-review.json`.
9. Verify both imports succeeded, updated counts match their exports, and the final report contains all recent persisted records across application statuses. Confirm valid results, statuses and notes were preserved.
10. Deliver the HTML report generated by the company import.

Keep both stages' input and review JSON files for audit. If no jobs need project
review, import an empty `decisions` array with the actual reviewer model and
exported metadata, then continue to company research. If no companies need
research, import an empty company review with its exported metadata to generate
the final combined report. Empty reviews are accepted only when their pending
scope is empty.

`full` defaults to 50 results per source and keyword and a seven-day window.
It accepts `--query`, `--sources`, `--limit`, `--days`, `--db` and `--out`.
Carry any custom `--days` and `--db` into the export, and the custom `--db`
and final HTML `--out` into the import. The import uses the review's
`snapshotAt` and `days`; an import-time `--days` does not override them.
Apply the same database and window to company research; pass the final HTML
output path to the company import.

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

### Company Research

Company research is independent of project assessments: a company can need
web research even when every project assessment is valid. Pending recent jobs
are grouped by exact employer name; aliases and similarly named businesses
are not automatically merged. Include an identity explanation and cite public
HTTP(S) sources with supporting excerpts.

The `research` export does not invoke a model or search engine. The acting
agent must execute the searches, record actual queries and provide the
structured `CompanyResearch` contract defined in
[`src/db/company-research.ts`](src/db/company-research.ts).
The [job-search-tracker skill](.agents/skills/job-search-tracker/SKILL.md)
contains the complete JSON example and required search steps.
When direct requests are blocked or content needs JavaScript, `research --url`
opens Playwright Chromium and saves rendered page evidence for the LLM to read.
It records the final URL, timestamp, HTTP status, access outcome and up to
20,000 characters of visible text, with a truncation flag. Chromium is headed
by default; `PW_HEADLESS=true` selects headless mode. This page-reading mode
does not search or update research. A blocked or failed page exits with code 1
and retains evidence; use interactive browsing if needed and record remaining
access blocks accurately.
Imports validate complete coverage, unchanged hashes, metadata, review metrics,
founder evidence and source URLs in one transaction. This validates the data
contract, not the truth of external claims or whether searches were executed.

Glassdoor findings distinguish `found`, `not_found` and `unavailable`.
Blocked pages and conflicting snippets remain unavailable, with unverifiable
ratings and review counts left null. Summarize employee opinions as attributed
reviews. Founder names require supporting sources; job titles such as CEO or
director do not establish founder status. Small companies mean a source-supported
workforce of up to 200 employees; leave unsupported size estimates `unknown`
and search for founders for both small and unknown-size employers.

The nullable `company_research_json` column is added automatically when an
existing database opens. Research import changes only pending recent rows;
valid research, project fields and application tracking remain preserved.
New listings reuse valid research from an exact-name employer. A company-name
change replaces research with that employer's cached record or clears it.
Title and description changes do not invalidate company research. There is no
automatic expiration. Reports show missing or malformed research as `Not researched`.

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
│   │   └── commands.ts                 # full, search, list, report, analyze, research, update, stats, discover
│   ├── runner.ts                       # Fault-isolated search runner & run logger
│   ├── db/
│   │   ├── schema.sql                  # DDL for jobs & scrape_runs tables
│   │   ├── client.ts                   # SQLite connection, upserts, queries, assessment validity
│   │   ├── project-analysis.ts         # Recent/pending scope and transactional review import
│   │   └── company-research.ts         # Company web-research contract, scope and import
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
│           ├── company-pages.ts        # Rendered company/Glassdoor page evidence
│           └── jobstreet.ts            # JobStreet SG Playwright adapter
└── tests/
    ├── cli-args.test.ts                # CLI argument and workflow tests
    ├── company-pages.test.ts           # Browser evidence, loading, access and failure handling
    ├── company-research.test.ts        # Migration, research validation, reuse and report safety
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
