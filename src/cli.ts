import { DEFAULT_DB_PATH, DEFAULT_FULL_QUERIES, parseCliArgs } from './cli/args.js';
import { DB_COMMANDS, handleDiscover } from './cli/commands.js';
import { openDatabase } from './db/client.js';
import { SOURCE_REGISTRY } from './sources/registry.js';

function printHelp(): void {
  const sources = SOURCE_REGISTRY.map(
    (s) => `${s.id} (${s.aliases.join(', ')})`,
  ).join(', ');
  console.log(`Singapore IT Job Search & SQLite Tracker

Registered sources: ${sources}

Commands:
  classify  [--limit 40] [--input decisions.json] [--out path] [--db path]
            Exports pending jobs across all ages/statuses, or persists source-backed harness decisions.
  classifier [--limit 40] [--input review.json] [--out path] [--db path]
            Inventories all stored jobs and exports exemplars for harness review, or validates completed decisions.
  research  [--days 7] [--company <exact-name>] [--input review.json] [--out path] [--db path]
            Exports pending companies for LLM web search, or stores cited company research.
            --url <page-url> [--out evidence.json] reads rendered content with Playwright for LLM review.
  analyze   [--days 7] [--input review.json] [--out path] [--db path]
            Exports jobs for LLM review, or stores a completed LLM review. No automatic scoring.
  full      [--query <text>] [--sources <list>] [--limit 30] [--days 7] [--out path] [--db path]
            Searches ${DEFAULT_FULL_QUERIES.join(', ')} by default and writes one combined report.
  search    --query <text> [--sources <list>] [--limit 20] [--db path]
  list      [--status new|saved|applied|...] [--source <id>] [--search text] [--limit 25] [--json] [--db path]
  report    [--status new|saved|applied|...] [--source <id>] [--search text] [--days 7] [--limit 500] [--out path] [--db path]
  update    --id <jobId> --status <status> [--notes "text"] [--db path]
  stats     [--db path]
  discover  [--tokens gh:foo,lv:bar] [--url <page-url>] [--boards path]

list/report filters: --domain <rubric-label> --role <rubric-label> --technology <rubric-label>
  Filters combine with AND and include pending/Unclear by default. --strict requires explicit matches.`);
}

async function main(): Promise<void> {
  const { command, values } = parseCliArgs(process.argv.slice(2));
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'discover') {
    process.exitCode = await handleDiscover(values);
    return;
  }

  const handler = DB_COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(values.db ?? DEFAULT_DB_PATH);
  try {
    process.exitCode = await handler(db, values);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
