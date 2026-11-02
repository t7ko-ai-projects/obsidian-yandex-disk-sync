# Backlog

Parked ideas, not scheduled. Each one that changes sync behavior needs a plan,
`docs/SYNC_USER_SCENARIOS.md` entries and tests before implementation.

- Bulk drops: realtime sync commits the canonical index once per file (13-36 s each,
  51 photos took about 28 min). Batch realtime commits or hand a large realtime backlog
  to the full-sync path (one commit for many files). Needs a written plan first.
- Bulk drops: parallel uploads may starve small index requests (six 15 s timeouts seen,
  ending in "Canonical index rollback is ambiguous"). Test with lower `maxConcurrency`.
- Honor `Retry-After` on 429 responses.
- Speed-ups that touch deliberate safety rules (need explicit approval): single-pass
  root listing, cache of verified service-file reads.
- Investigate the intermittent failure seen once in `npm test` during release
  (suspect the timing assertions in `tests/remote-poll-and-rate.test.ts`).
- Unexplained "deleted 1" in the 11:46Z full sync of the bulk-upload test.
