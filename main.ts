// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models write,
// in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text
// files. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old, new] pairs, for the `R` output lines. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Split a file's text into its lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const isBlankish = (s: string): boolean => /^[ \t]*$/.test(s);

/** Normalise one line for a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trailingWs(s);
  return trailingWs(s).replace(/^[ \t]+/, '');
}

function matchesAt(lines: string[], o: string[], tier: number, at: number): boolean {
  for (let k = 0; k < o.length; k += 1) {
    if (normLine(lines[at + k]!, tier) !== normLine(o[k]!, tier)) return false;
  }
  return true;
}

/** Positions where O occurs in lines, at one tier, starting at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (matchesAt(lines, o, tier, i)) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; or only 0 when strict) at which O occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One replaced block: O (old lines) and N (new lines), with context flags in the same order. */
interface Block {
  o: string[];
  n: string[];
  oCtx: boolean[];
  nCtx: boolean[];
}

/**
 * Build the lines that replace the matched lines: context lines are written as the file's own matched
 * lines, and at tier 2 every other line of N is re-indented from O's first line to the file's (section 5).
 */
function buildReplacement(matched: string[], b: Block, tier: number): string[] {
  const oCtxIdx: number[] = [];
  for (let k = 0; k < b.o.length; k += 1) if (b.oCtx[k]) oCtxIdx.push(k);
  const f = matched.length > 0 ? leadingWs(matched[0]!) : '';
  const p = b.o.length > 0 ? leadingWs(b.o[0]!) : '';
  const out: string[] = [];
  let c = 0;
  for (let j = 0; j < b.n.length; j += 1) {
    if (b.nCtx[j]) {
      out.push(matched[oCtxIdx[c]!]!);
      c += 1;
    } else if (tier === 2) {
      const line = b.n[j]!;
      if (!isBlankish(line) && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(b.n[j]!);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk extends Block {
  /** The `-` side start line, 1-based, from the header. */
  a: number;
  /** The `+` lines of the hunk, in body order. */
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  /** Old/new path from the `---`/`+++` pair; null means `/dev/null`. */
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkBody(body: string[], a: number): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const oCtx: boolean[] = [];
  const nCtx: boolean[] = [];
  const plus: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (l.startsWith('\\')) continue; // A `\` line refers to the body line before it; handled below.
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push(t);
      oCtx.push(true);
      nCtx.push(true);
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
      oCtx.push(false);
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
      nCtx.push(false);
      plus.push(l.slice(1));
    }
  }
  // A `\` line matters when it follows the hunk's last context or `+` line (for a change or move),
  // or its last `+` line (for a creation).
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const noEol = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
  const plusNoEol = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { o, n, oCtx, nCtx, a, plus, noEol, plusNoEol };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  const startSection = (s: Section): void => {
    sections.push(s);
    section = s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ gitOld: m[1]!, gitNew: m[2]!, oldPath: undefined, newPath: undefined, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(line);
      const newP = diffPath(lines[i + 1]!);
      if (section !== null && section.hunks.length === 0 && section.oldPath === undefined && section.newPath === undefined) {
        section.oldPath = oldP;
        section.newPath = newP;
      } else {
        startSection({ gitOld: null, gitNew: null, oldPath: oldP, newPath: newP, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (section !== null && section.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number.parseInt(m[1]!, 10);
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      section.hunks.push(parseHunkBody(body, a));
      i = j;
      continue;
    }
    if (section !== null && section.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        if (section.renameFrom === null) section.renameFrom = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        if (section.renameTo === null) section.renameTo = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) {
        section.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        section.deletedFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and
      // any other header line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...h.n);
      if (atEnd) final = !h.noEol;
      d += h.n.length;
    } else {
      const found = findTier(lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const matched = lines.slice(best, best + h.o.length);
      const rep = buildReplacement(matched, h, found.tier);
      const runsToEnd = best + h.o.length === lines.length;
      lines.splice(best, h.o.length, ...rep);
      if (runsToEnd) final = !h.noEol;
      d += h.n.length - h.o.length;
    }
  }
  return joinFile(lines, f.br, final);
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null = null;
    let newP: string | null = null;
    if (s.oldPath !== undefined) oldP = s.oldPath;
    else if (s.renameFrom !== null) oldP = s.renameFrom === '/dev/null' ? null : s.renameFrom;
    else if (s.gitOld !== null) oldP = s.gitOld;
    if (s.newPath !== undefined) newP = s.newPath;
    else if (s.renameTo !== null) newP = s.renameTo === '/dev/null' ? null : s.renameTo;
    else if (s.gitNew !== null) newP = s.gitNew;
    const isCreate = oldP === null || s.newFile;
    const isDelete = newP === null || s.deletedFile;
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoEol = false;
      for (const h of s.hunks) {
        plus.push(...h.plus);
        if (h.plus.length > 0) lastPlusNoEol = h.plusNoEol;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    // oldP and newP are both real paths here.
    if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
    if (!safe(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    if (oldP !== newP) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(before, s.hunks, strict, oldP!);
      tree.now.set(newP!, out);
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const out = applyHunks(before, s.hunks, strict, oldP!);
    tree.now.set(oldP!, out);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const b: Block = {
      o: oldLines,
      n: newLines,
      oCtx: oldLines.map(() => false),
      nCtx: newLines.map(() => false),
    };
    const rep = buildReplacement(f.lines.slice(pos, pos + oldLines.length), b, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f.lines, f.br, f.final));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk extends Block {
  anchor: string | null;
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Update only: the `*** Move to:` path, if any. */
  moveTo: string | null;
  /** Add only: the file's lines. */
  addLines: string[];
  /** Update only. */
  chunks: V4aChunk[];
  /** 1-based line of the `*** Update File:` line, for the no-chunk parse error. */
  lineNo: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i += 1;
    // The section's lines run to the next section start or `*** End Patch`.
    const content: Array<{ text: string; no: number }> = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      content.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) addLines.push(c.text.slice(1));
        else if (c.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], lineNo: headerLine });
    } else if (kind === 'delete') {
      for (const c of content) {
        if (!blank(c.text)) throw new Exit2(`error: parse ${c.no}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], lineNo: headerLine });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < content.length && content[k]!.text.startsWith('*** Move to: ')) {
        moveTo = content[k]!.text.slice(13).trim();
        k += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let betweenChunks = false;
      while (k < content.length) {
        const c = content[k]!;
        const t = c.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, o: [], n: [], oCtx: [], nCtx: [] };
          chunks.push(cur);
          betweenChunks = false;
          k += 1;
        } else if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${c.no}`);
          cur.eof = true;
          cur = null;
          betweenChunks = true;
          k += 1;
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0 && !betweenChunks) {
              cur = { anchor: null, eof: false, o: [], n: [], oCtx: [], nCtx: [] };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${c.no}`);
            }
          }
          if (t === '' || t.startsWith(' ')) {
            const txt = t === '' ? '' : t.slice(1);
            cur.o.push(txt);
            cur.n.push(txt);
            cur.oCtx.push(true);
            cur.nCtx.push(true);
          } else if (t.startsWith('-')) {
            cur.o.push(t.slice(1));
            cur.oCtx.push(false);
          } else {
            cur.n.push(t.slice(1));
            cur.nCtx.push(false);
          }
          k += 1;
        } else {
          throw new Exit2(`error: parse ${c.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, lineNo: headerLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // Update.
    const moveTo = s.moveTo;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    const lines = f.lines;
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let j = cursor; j < lines.length; j += 1) {
            if (normLine(lines[j]!, tier) === normLine(ch.anchor!, tier)) {
              foundAt = j;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', s.path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...ch.n);
        cursor = at + ch.n.length;
      } else {
        // The first tier with an occurrence at or after the cursor; an end-of-file chunk
        // takes only an occurrence that ends at the file's last line.
        let tierFound = -1;
        let pos = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          const occ = occurrences(lines, ch.o, tier, cursor);
          if (occ.length === 0) continue;
          tierFound = tier;
          if (ch.eof) {
            const eofPos = occ.find((p) => p + ch.o.length === lines.length);
            if (eofPos === undefined) {
              tierFound = -1;
              pos = -1;
              continue;
            }
            pos = eofPos;
          } else {
            pos = occ[0]!;
          }
          break;
        }
        if (tierFound < 0) throw new Fail('no-match', s.path);
        const matched = lines.slice(pos, pos + ch.o.length);
        const rep = buildReplacement(matched, ch, tierFound);
        lines.splice(pos, ch.o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(lines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one line per changed path in byte order; a move's `R old -> new` line sorts by `<new>`.
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      movedOld.add(oldP);
      movedNew.set(newP, oldP);
    }
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [newP, oldP] of movedNew) {
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    if (check) continue;
    rmSync(oldP, { force: true });
    mkdirSync(dirname(newP), { recursive: true });
    writeFileSync(newP, tree.now.get(newP)!);
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
