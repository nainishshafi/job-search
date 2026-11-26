# Classifier implementation verification

Run commands from the workspace root, alongside the development checks required by `AGENTS.md`.

- The production `tsconfig.json` excludes tests, and `tsx` executes them without typechecking. Explicitly check affected test files. For the classifier tests:
  ```powershell
  node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck tests/classifier.test.ts
  ```
  Require exit code 0 with no diagnostics. Add other affected test paths when appropriate.
- Use `TestContext.mock.method` and restore mocks through the mock API. Assigning to a Node module member such as `fs.lstatSync` can compile incorrectly because its declaration is readonly even when the assignment works at runtime.
- SQLite SELECT operations can update WAL shared-memory reader bookkeeping. In an isolated preservation fixture, compare database and WAL bytes, stored rows and integrity, and SHM size when present. Do not require every SHM byte to remain unchanged after a read.
- A bounded exemplar count does not bound corpus-loading memory: inventory currently materializes the corpus with `SELECT *`. Include corpus size and source-text size when describing resource costs.
- Daily modulo sampling can repeat at a weekly cadence. Verify actual membership before claiming samples rotate without overlap.
- Exact source quotes establish textual support, not semantic accuracy or model identity. Report manual reviews and automated checks separately, including unavailable checks.

Use isolated fixtures for preservation checks; do not test output collisions against the production database.
