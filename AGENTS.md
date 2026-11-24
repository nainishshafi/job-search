# Project Instructions (`sg-it-job-search`)

## Job Tracker Queries & Commands

When the user asks about jobs (e.g., *"what are the new jobs"*, *"job stats"*, *"search jobs"*, *"update job status"*), follow [job-search-tracker](.agents/skills/job-search-tracker/SKILL.md) and execute the CLI commands directly without prompting:

- Use `node --import tsx src/cli.ts <command>` (never `npm run dev -- ...`, which strips `--flag` arguments).
- Database path defaults to `data/jobs.db`.
- Treat "run full" as one complete agent workflow: scrape, export only recent listings with missing or invalidated assessments, review those pending listings with the LLM, import validated decisions while preserving valid results, and deliver the final report with all recent persisted assessments. Follow the skill's analysis workflow automatically after `full`; the CLI command alone only scrapes and produces a preliminary report.

## Development Commands & Review

- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Tests: `npm test`
- Run `agent-orchestrator` (`plan -> develop -> codereview -> complexitychecks -> architecturechecks -> halucinationchecks -> securitychecks`) alongside `npm run typecheck` and `npm test` for development changes.
