# Project Instructions (`sg-it-job-search`)

## Job Tracker Queries & Commands

When the user asks about jobs (e.g., *"what are the new jobs"*, *"job stats"*, *"search jobs"*, *"update job status"*), follow [job-search-tracker](.agents/skills/job-search-tracker/SKILL.md) and execute the CLI commands directly without prompting:

- Use `node --import tsx src/cli.ts <command>` (never `npm run dev -- ...`, which strips `--flag` arguments).
- Database path defaults to `data/jobs.db`.

## Development Commands

- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Tests: `npm test`
