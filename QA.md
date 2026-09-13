# Godomall bulk-transfer update — 2026-09-14

Ports the Cafe24 transfer safeguards to this platform's own API and ledger. No customer reviews were created or deleted during validation.

## Changes

- Persist a platform-specific claim before every remote write. Retain successful and uncertain claims across browser retries and server restarts. Release only definite non-writes or confirmed app-managed deletions.
- Require a configured, working ledger before posting; report success only after recording the confirmed write. Reject malformed responses and partial results whose row identities are unknown.
- Assign occurrence identities across the entire file, preserving intentional identical reviews across request boundaries. Preserve legacy hash matching by multiplicity.
- Parse spreadsheets in a Web Worker, preserve dates and every photo column, validate rather than truncate content/ratings/photos, and fingerprint the file with SHA-256.
- Resume only from a completely successful contiguous prefix. Retry only server-identified unwritten rows, stop on unknown outcomes, and honor Stop before another dispatch.
- Route multipart imports through the same validated batch flow. Reject oversized requests explicitly.
- Reserve free usage atomically before writing. Paid transfers bypass the free counter; retain server-confirmed plan state in progress. Unknown original writes retain their reservation; blocked replays do not charge again.
- Clear browser checkpoints for explicit deletions, release corresponding claims transactionally, and recheck the remaining final page after partial deletion.

## Platform-specific behavior

Godomall retains bulk writes of up to 100 reviews per remote call (the app route accepts at most 200). Only full-batch success can establish input-row success from its count-only response. A partial response blocks that batch for verification, without guessing which rows succeeded or stripping photos.

New confirmed writes deduplicate even while their article numbers are pending. Old unconfirmed ledger rows remain blocked. Article reconciliation is bounded, excludes IDs already assigned to another row, and accepts only unique content/writer/product/rating matches with compatible photo and registration-time evidence. Identical or transformed-photo candidates may require manual mapping before deletion. A DELETE 404 is kept as a failure because absence is not proven for this API.

Paid checks reuse one database pool and schema initialization while reading current subscription records on every check. A status-storage outage returns an error instead of silently turning a paid account into free. Existing trial/billing work in the main workspace is preserved separately from this release.

Official API reference: [Godomall server API specification](https://server-docs.godomall.com/spec/server-api.yml).

## Verification

- `npm test`: parser, occurrence identities, client checkpoints, subset retries, timeouts, uncertain outcomes, ledger failures, request limits, paid-plan progress, and platform response/payload checks.
- `npm run test:db`: disposable local PostgreSQL 17 only. Covers concurrent claims/reservations, restart protection, legacy duplicates, paid access, verified deletion, and a 25,000-review full client → route → writer → database transfer.
- The stress test preserved exactly 25,000 remote mock records and 25,000 ledger rows, including 1,000 contents repeated 25 times. It injected 2 throttled responses, a lost remote response, and a lost browser response. The unknown write resumed only after simulated verified reconciliation. Complete-file replay created zero additional reviews.
- Real production browser worker: 50,000 rows, SHA-256 verified, transferred input buffer, UI heartbeat active. Local measurement: 783 ms; 76 main-thread callbacks.
- Lint, TypeScript, and production build.

The 25,000-review run uses mocked platform calls and simulated pacing; it proves the tested failure behavior, not live throughput. The browser check measures local parsing, not a platform transfer.

To reproduce the browser check, build and start the app locally, then run `node scripts/tests/verify-browser-worker.cjs` with `TEST_APP_URL=http://127.0.0.1:PORT/support`. Optional `PLAYWRIGHT_MODULE_PATH` and `CHROMIUM_EXECUTABLE` select an existing Playwright/browser installation. Only loopback network requests are permitted by this harness.

## Rollout and recovery

Schema changes are additive and use app-specific table names. Claims never expire automatically. A crash can occur between claim creation and posting, or between posting and ledger persistence; such rows stay blocked until verified. The original complete spreadsheet and selected product are required to reconstruct occurrence hashes. Verify complete review text, writer, rating, date, options, and photos before recording a known remote success or releasing a proven non-write. Quota reservations interrupted during persistence may also require reconciliation.

Transfers pause when the browser closes and resume with the same complete file. Historical orphan posts or older content alterations cannot be repaired automatically. A live paid-shop transfer of at least 25,000 reviews, including photos, stop/resume, and complete-file replay, remains pending. No live-volume stability guarantee is implied by the local tests.
