[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kuyukbot1/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kuyukbot1/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

A command-line tool that applies AI-written edits in four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree of files, to the specification in `SPEC.md`.

## Usage

```
node main.ts [options] [PATCH]
```

Run with the working directory as the root of a tree of text files. The patch comes from the file argument, or from stdin when no file is given. Every edit in the patch is applied, or none of them are — a failed edit leaves the tree untouched. The tool prints what it changed (`M`, `A`, `D`, `R` lines, then `ok: N files`) or why it failed.

## Formats

- **Unified diff** — `diff --git` headers, `---`/`+++` file lines, `@@` hunks. Hunk line numbers are a hint: the tool finds the lines each edit names at the first of three matching tiers, so drifted whitespace or indentation still matches.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks, with the file path on the line above the block.
- **V4A** — `*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` / `*** End Patch` sections.
- **JSON** — text-editor tool calls as JSON (`create`, `str_replace`, and friends), one object per line or as an array.

## Files

- `main.ts` — the CLI (Node 22, standard library only, deterministic)
- `runner.ts` — the trial runner the grader uses beside `main.ts`
- `SPEC.md` — the whole contract: matching tiers, output format, error codes
- `check.ts` — run the public practice set: `node check.ts <practice.json>`

## Verification

- Public practice set: **100/100 checks pass, practice score 1000** (unified 30, SEARCH/REPLACE 20, V4A 20, JSON 15, CLI 15), run twice with byte-identical output.
- 41 adversarial edge cases (chained moves, move-then-modify/delete, V4A pure moves and EOF chunks, JSON array-fault line numbers, CLI usage errors, unsafe paths, tier-2 re-indentation): **41/41 pass**.
- Deterministic: the same check gives the same exit code, stdout, and files every run.
- Size: 65,888 bytes of source total, every file under 1 MiB.

## Bounty

make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — $100, 10 places × $10, escrowed. Entries close Monday 24 November 2026, 21:00 WIB.
