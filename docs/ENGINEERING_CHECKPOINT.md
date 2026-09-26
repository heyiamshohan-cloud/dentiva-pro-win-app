# DENTIVA PRO — ENGINEERING CHECKPOINT

> Single source of truth for build/resume state. Updated at every milestone.
> If interrupted: read this file, verify claims against repo + test runs, resume at "NEXT EXACT ACTION".

## IDENTITY
- Product: Dentiva Pro v1.0.0 (final commercial V1, no V2 planned)
- Repo: heyiamshohan-cloud/dentiva-pro-win-app
- Branch: arena/01a0d9ba-dentiva-pro-win-app (base 763b782 "Initial commit")
- Build date context: 2026-09-25 UTC

## REPOSITORY GROUND TRUTH (verified 2026-09-25)
- Fresh repo confirmed: single commit, only README.md present. No legacy code.
- Sandbox: Linux x64 (e2b), Node 22.22.3, npm 10.x, 2 CPU / 3.8GB RAM / 20GB free.
- ENVIRONMENTAL LIMITATION: No Windows OS and no Wine in sandbox. Windows install/uninstall GUI validation cannot be literally executed here; Windows x64 artifacts will be cross-built with electron-builder (resedit-based, no wine requirement) and every non-Windows-specific validation (DB, services, IPC, PDFs, restore, scale, security) executed natively. This is the plan-enforced honest boundary.

## ARCHITECTURE (decided)
- Electron (44.x) main + preload (contextBridge only, contextIsolation on, nodeIntegration off, sandbox on).
- Renderer: dependency-free TypeScript SPA (hash router + component kit), custom design system (CSS tokens).
- DB: SQLite via better-sqlite3 (WAL, foreign_keys ON, synchronous transactional writes).
- Money: integer paisa (BDT smallest unit). No floats anywhere in finance.
- Validation: zod v4 schemas in src/shared, enforced at the IPC gateway boundary (and reused by forms).
- PDF: pdfkit engine in main process; verified in tests via pdf-parse text extraction.
- Backup/restore: zip archive (db + manifest + sha256), whitelist entry validation, zip-slip rejection, atomic swap with safety copy + crash marker + startup recovery.
- Auth: local users (scrypt hash), sessions in main memory, RBAC enforced in service gateway (not UI).
- No activation/license/serial systems will ever be created (product requirement).

## PHASE STATE
| Phase | State | Evidence |
|---|---|---|
| 1. Repo + architecture | VERIFIED | build OK; tsc strict green |
| 2. DB + migrations | VERIFIED | integration/database.test.ts green |
| 3. Security foundation | VERIFIED | integration/auth.test.ts green (lockout, RBAC deny, redaction, scrypt) |
| 4–23. Feature services + IPC + documents/backup | VERIFIED | 134 integration+unit tests green (12 files), incl. doc forensics, restore batteries |
| 24. Performance/scale | VERIFIED @ 10K | tests/perf/scale.test.ts 10/10 green at N=10,000 (see timings below); 100K profile runnable via DENTIVA_SCALE=100000 npm run perf |
| 25–30. Forensic audits | IN PROGRESS | real defects fixed so far: lot-expiry GROUP BY, import row counter, FTS delete triggers, payment placeholder counts, BAD date query ranges; audit incomplete |
| 31–33. Windows packaging/clean install/workflow | NOT STARTED | scripts/pack.mjs + electron-builder.yml present, not yet executed |
| 34–36. Final regression/release | NOT STARTED | - |

## EXECUTED EVIDENCE (2026-09-25)
- `npx vitest run` → 134/134 passed (12 files: 3 unit + 9 integration).
- `npx tsc --noEmit` → clean (src + tests).
- `node scripts/build.mjs` → builds out/ (main+preload+renderer bundles).
- `npx vitest run --config vitest.perf.config.ts` (DENTIVA_SCALE=10000) → 10/10 green; timings: seed 10K patients ≈ 4.8s (~470µs/pt), phone/name/code search ≈ 0–1ms, dashboard ≈ 4ms, full 200-page pagination of all 10K rows ≈ 260ms.
- Commits: aeaf7b9 (foundation, 104 tests) → 3afc963 (forensic batteries +2 defect fixes, 134 tests).

## DEFECTS FOUND & FIXED THIS LOOP (with evidence)
1. importExport swallowed per-row duplicates but still counted them as inserted → run() now returns inserted|skipped; counters truthful (tests/integration/operations.test.ts).
2. expiring-lot query grouped by (item,batch,expiry) so outbound batches left stock at full → regroup by lot (item+batch) with MAX(expiry) from intake (operations.test.ts).
3. (previous session) FTS5 'delete' trigger command invalid on full-content tables; payments INSERT placeholder count; timeline cursor length; plan items ORDER BY phantom column; clinicLocalToIso accepted 25:00.
4. Stale Vite/vitest transform cache replayed deleted tests → lesson: clear node_modules/.vite + node_modules/.vitest when a test's behavior is impossible for the on-disk source.

## KNOWN BLOCKERS
- None currently.

## DATABASE/SCHEMA STATE
- user_version migration chain implemented; schema covers all domains incl. RBAC, audit, FTS5 (patients). Attachments dir + backup dir convention under userData.

## RELEASE STATE
- None. Version pinned 1.0.0. Packaging scripts exist but unexecuted.

## NEXT EXACT ACTION
1. Remaining forensic audits P0: concurrency/idempotency double-submit (payments/queue serial), WAL crash recovery outside restore flow, audit-log redaction scan, command-palette + notifications dedupe (partially covered).
2. Renderer UI (only place remaining in "full product"): design system already stubbed; build all screens against the verified gateway.
3. Windows packaging via scripts/pack.mjs (cross-build); SHA256 manifest; document install steps honestly.
4. Final docs: SPEC traceability (docs), README, FINAL_RELEASE_REPORT.md.

## RECOVERY INSTRUCTIONS
- `npm install` if node_modules missing.
- `npm run build` to produce out/. `npm test` full suite; `npm run perf` scale suite (DENTIVA_SCALE env, default 10000, clamp 1000..100000).
- If tests misbehave inexplicably: `rm -rf node_modules/.vite node_modules/.vitest` then rerun.
- Never trust this file over re-running tests; regenerate evidence after resume.
