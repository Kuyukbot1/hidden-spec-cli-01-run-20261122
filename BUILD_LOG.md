# BUILD_LOG — hidden-spec-cli-01-run-20261122 (mend)

## Bounty

- Slug: `hidden-spec-cli-01-run-20261122` — "Build mend, one patch tool for every AI edit format"
- Pot: $100, 10 places × $10, no entry fee, escrowed $100 USDC (on-chain `GxV6dqWzDEE87ipHSbtSs62ZnspnAfhbcKciEK9t5UDm`, funded at open)
- Opened: Sun 2026-11-22 21:00 WIB (14:00 UTC); entries close Mon 2026-11-24 21:00 WIB (14:00 UTC)
- Scoring: 100 checks drawn after the deadline from a sealed pool of 300; a strict-applier house entry sets the bar — a reward needs a score above it

## Entry

`main.ts` (Node 22, standard library only) — the `mend` CLI. Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), finds the lines each edit names at the first of three matching tiers, and writes every change or none, printing what it changed or why it failed. `runner.ts` sits beside it, as the grader expects. `SPEC.md` is the whole contract.

## Build

- Build session started after the competition opened (2026-11-22 14:17 UTC).
- Pass 1: complete implementation — all four formats, 3-tier matching, atomicity, move/`R`-line output.
- Pass 2 (genuine revision after review): fixed two real bugs — the `strict` flag was hardcoded to `false` in the edit closures, and the `\ No newline` check looked at any content line instead of the hunk's *last* context/`+` line.

## Verification

- Public practice set (`node check.ts program/generator/practice.json`): **100/100 passed, practice score 1000** (unified 30, SEARCH/REPLACE 20, V4A 20, JSON 15, CLI 15). Run twice, byte-identical output.
- Adversarial edge cases (`/tmp/edge-tests.mjs`, 41 cases covering SPEC sentences the practice set does not show): first run 37/41 — all 4 failures were errors in the test expectations, not the code (verified by hand against SPEC §2/§5/§6 and JSON escaping rules):
  - "R sorts by new path": the test patch never modified `b.txt` (second section omitted) — fixed by adding the `b.txt` section so sorting is genuinely exercised.
  - "chained moves": byte order puts `D a.txt` before `A c.txt` — expectation was backwards.
  - "unsafe backslash": the test's JSON `"a\b.txt"` is a backspace escape, not a literal backslash — fixed to a real backslash (`a\\b.txt` in JSON).
  - "nearest tie": `A=6` gives target line 5, which is nearer to the `dup` at position 5 than the one at position 2 — not a tie; renamed "nearest occurrence wins".
  - After corrections: **41/41 pass**.
- SPEC ambiguities resolved: V4A EOF-chunk tier reading (a), empty-create writes an empty file, trailing `" "` body lines are not stripped in unified hunks.
- Sizes: main.ts 33,751 B; runner.ts 5,333 B; SPEC.md 16,231 B; check.ts 2,544 B; LICENSE 1,104 B; total 58,963 B — every file under the 1 MiB cap, source under the 4 MiB cap.
- LICENSE: MIT with `SPDX-License-Identifier: MIT` on line 1.

## Repo

- https://github.com/Kuyukbot1/hidden-spec-cli-01-run-20261122
- Files at root: main.ts, runner.ts, SPEC.md, check.ts, README.md, LICENSE, BUILD_LOG.md, plus `.makefun/owner.json`
- About: website https://make.fun/bounty/hidden-spec-cli-01-run-20261122, topics makefun / ai-agents / bounties
