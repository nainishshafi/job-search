# Classifier implementation verification

Run commands from the workspace root, alongside the development checks required by `AGENTS.md`.

- The production `tsconfig.json` excludes tests, and `tsx` executes them without typechecking. Explicitly check affected test files. For the classifier tests:
  ```powershell
  node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck tests/classifier.test.ts tests/job-classification.test.ts tests/report.test.ts
  ```
  Require exit code 0 with no diagnostics. Add other affected test paths when appropriate.
- Use `TestContext.mock.method` and restore mocks through the mock API. Assigning to a Node module member such as `fs.lstatSync` can compile incorrectly because its declaration is readonly even when the assignment works at runtime.
- SQLite SELECT operations can update WAL shared-memory reader bookkeeping. In an isolated preservation fixture, compare database and WAL bytes, stored rows and integrity, and SHM size when present. Do not require every SHM byte to remain unchanged after a read.
- A bounded exemplar count does not bound corpus-loading memory: inventory currently materializes the corpus with `SELECT *`. Include corpus size and source-text size when describing resource costs.
- Per-job batches stream rows and retain at most 100 sources; filter queries can still scan all candidate rows to find matches. Apply classification/date predicates before LIMIT and test a matching row beyond the initial limit. Row and input-byte caps do not bound total process memory: decoded objects and serialized output also contribute, and artifact guards scale with the retained artifact directory.
- Verify exact authoritative per-database batch coverage, unchanged selected source/rubric hashes, unrelated corpus growth, valid replay preservation, and rollback on both invalid late decisions and real filesystem audit-write failures. Compare every nonclassification field before and after import.
- Protect internal pending manifest destinations as well as `--out`: reject symlinks, hardlinks and directories before either export is written. Reserve the default source export path during import even when that file is absent.
- Write per-job audit bytes to an exclusively owned staging file, then publish without overwriting an existing destination. Inject a partial staging write failure and check database rollback, removal of owned temporary files, preservation of existing files and successful retry.
- Check ordered iterator queries with `EXPLAIN QUERY PLAN`; streaming JavaScript does not prevent SQLite from materializing a temporary sort. Cover default, status, source and combined filters. Bound input and manifest reads through the checked file descriptor and test the 16 MiB limit.
- Completed `Unclear` classifications remain valid and must not be re-exported as pending. Corrupt, source-stale and rubric-stale payloads are pending. Check default unknown-inclusive AND filters and strict matching separately.
- Use one-pass report placeholder substitution so stored text resembling template tokens remains data. Browser checks should compare filter behavior, pending versus Unclear, escaped provenance and dialog content.
- Daily modulo sampling can repeat at a weekly cadence. Verify actual membership before claiming samples rotate without overlap.
- Exact source quotes establish textual support, not semantic accuracy or model identity. Report manual reviews and automated checks separately, including unavailable checks.

Use isolated fixtures for preservation checks; do not test output collisions against the production database.
