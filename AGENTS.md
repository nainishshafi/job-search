# Project Instructions (`sg-it-job-search`)

## Job Tracker Queries & Commands

When the user asks about jobs (e.g., *"what are the new jobs"*, *"job stats"*, *"search jobs"*, *"update job status"*), follow [job-search-tracker](.agents/skills/job-search-tracker/SKILL.md) and execute the CLI commands directly without prompting:

- Use `node --import tsx src/cli.ts <command>` (never `npm run dev -- ...`, which strips `--flag` arguments).
- Database path defaults to `data/jobs.db`.
- Treat "run full" as one complete agent workflow: scrape (default `--days 7`), review/import pending recent project assessments, export pending companies, perform actual LLM web searches for company information and Glassdoor reviews plus founders for small or unknown-size employers, import cited company research, run a deterministic pipeline check (`node --import tsx src/cli.ts check --days 7`), and deliver the final report with all recent persisted results. Follow workflows 6 and 7 in the skill automatically after `full`; the CLI command alone only scrapes and produces a preliminary report. Preserve valid project assessments and company research independently.
- Keep project skills under `.agents/skills`.
- Use [.agents/skills/job-classifier/SKILL.md](.agents/skills/job-classifier/SKILL.md) for new project-domain decisions and classifier building. After the full workflow, run the classifier due check and complete the source-backed exemplar review when due. This runs through the acting harness model, without a separate model API. Preserve existing valid assessments.
- During full workflows, after project analysis, complete source-backed per-job `classify` batches before company import generates the final report. Keep periodic `classifier` exemplars separate. Classification filters include pending/Unclear by default; `--strict` requires explicit matches.

## Development Commands & Review

- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Tests: `npm test`
- `tsconfig.json` excludes tests, and `tsx` runs them without typechecking. When changing TypeScript tests, explicitly typecheck the affected files as well; see the [classifier verification guidance](.agents/skills/job-classifier/verification.md) for the command.
- Run `agent-orchestrator` (`plan -> develop -> codereview -> complexitychecks -> architecturechecks -> halucinationchecks -> securitychecks`) alongside `npm run typecheck` and `npm test` for development changes.
