// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does SPEC.md
// sections 1 to 10: the command line, the output and exit codes, safe paths, format detection, JSON edits and the
// all-or-nothing write, plus line matching at three tiers (section 5) and the other three formats: unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Moves a successful edit performed, in order; the exit-0 output turns a qualifying pair into an R line. */
  readonly moves: Array<{ from: string; to: string }> = [];
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

// ---- Files and line matching (SPEC.md sections 3 and 5) ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s));

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** Every 0-based position at or after `from` where O matches the file's lines at this tier. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(lines[i + k]!, tier) !== normLine(O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which O occurs at least once (at or after `from`; for an end-of-file chunk only an
 * occurrence ending at the file's last line counts), with its positions. Null when O occurs nowhere.
 */
function findTier(lines: string[], O: string[], strict: boolean, from: number, eof: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t, from).filter((p) => !eof || p + O.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is (single lines). */
function anchorLine(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/**
 * Build the replacement lines for O found at `pos`: a context line is written as the file's own matched line,
 * never the patch's; at tier 2 every other line of N is re-indented from P (the leading whitespace of O's first
 * line) to F (that of the file's first matched line). A line that is empty or only whitespace is written as it is.
 */
function buildReplacement(lines: string[], pos: number, O: string[], N: string[], nCtx: boolean[], nCtxIdx: number[], tier: number): string[] {
  const out: string[] = [];
  const F = leadWs(lines[pos]!);
  const P = leadWs(O[0]!);
  for (let j = 0; j < N.length; j++) {
    if (nCtx[j]) {
      out.push(lines[pos + nCtxIdx[j]!]!);
      continue;
    }
    const l = N[j]!;
    if (tier === 2 && !onlyWs(l) && l.startsWith(P)) out.push(F + l.slice(P.length));
    else out.push(l);
  }
  return out;
}

// ---- Unified diff hunks (SPEC.md section 6) ----

interface Hunk {
  a: number;
  c: number;
  body: string[];
  O: string[];
  N: string[];
  nCtx: boolean[];
  nCtxIdx: number[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
}

function buildHunk(a: number, c: number, body: string[]): Hunk {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: boolean[] = [];
  const nCtxIdx: number[] = [];
  let lastCtxOrPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b.startsWith(' ') || b === '') {
      const t = b === '' ? '' : b.slice(1);
      O.push(t);
      N.push(t);
      nCtx.push(true);
      nCtxIdx.push(O.length - 1);
      lastCtxOrPlus = i;
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push(b.slice(1));
      nCtx.push(false);
      nCtxIdx.push(-1);
      lastCtxOrPlus = i;
    }
    // A `\` line refers to the body line before it and adds no line of its own.
  }
  const noFinal = lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < body.length && body[lastCtxOrPlus + 1]!.startsWith('\\');
  return { a, c, body, O, N, nCtx, nCtxIdx, noFinal };
}

/** Apply a section's hunks in order to a file's lines; throws Fail on the first hunk that fails. */
function applyHunks(lines: string[], br: string, finalBr: boolean, hunks: Hunk[], strict: boolean, path: string): string {
  let cur = [...lines];
  let curFinal = finalBr;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > cur.length) at = cur.length;
      const wasEnd = at === cur.length;
      cur.splice(at, 0, ...h.N);
      if (wasEnd && h.N.length > 0) curFinal = !h.noFinal;
      d += h.N.length;
    } else {
      const found = findTier(cur, h.O, strict, 0, false);
      if (!found) throw new Fail('no-match', path);
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
      const rep = buildReplacement(cur, best, h.O, h.N, h.nCtx, h.nCtxIdx, found.tier);
      const atEnd = best + h.O.length === cur.length;
      cur.splice(best, h.O.length, ...rep);
      if (atEnd) curFinal = !h.noFinal;
      d += h.N.length - h.O.length;
    }
  }
  return joinFile(cur, br, curFinal);
}

/** A `\` line follows the section's last `+` line (for a created file's final line break). */
function sectionNoFinal(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i]!.startsWith('+')) return i + 1 < body.length && body[i + 1]!.startsWith('\\');
    }
  }
  return false;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Section {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function resolveOld(s: Section): string | null {
  if (s.pairOld !== undefined) return s.pairOld;
  if (s.renameOld !== undefined) return s.renameOld;
  return s.diffOld ?? null;
}

function resolveNew(s: Section): string | null {
  if (s.pairNew !== undefined) return s.pairNew;
  if (s.renameNew !== undefined) return s.renameNew;
  return s.diffNew ?? null;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (line: string): string => {
    const t = line.slice(4);
    const tab = t.indexOf('\t');
    return (tab >= 0 ? t.slice(0, tab) : t).trim();
  };
  let cur: Section | null = null;
  let inHeader = false;
  let headerHasPair = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1], diffNew: m[2], isNew: false, isDeleted: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerHasPair = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
      if (cur !== null && inHeader && !headerHasPair) {
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        const oldRaw = headerPath(line);
        const newRaw = headerPath(lines[i + 1]!);
        cur.pairOld = oldRaw === '/dev/null' ? null : stripPrefix(oldRaw);
        cur.pairNew = newRaw === '/dev/null' ? null : stripPrefix(newRaw);
        headerHasPair = true;
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        const oldRaw = headerPath(line);
        const newRaw = headerPath(lines[i + 1]!);
        cur = {
          pairOld: oldRaw === '/dev/null' ? null : stripPrefix(oldRaw),
          pairNew: newRaw === '/dev/null' ? null : stripPrefix(newRaw),
          isNew: false,
          isDeleted: false,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
        headerHasPair = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const c = parseInt(m[3]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, c, body));
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i++;
  }
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const oldPath = resolveOld(sec);
    const newPath = resolveNew(sec);
    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (sec.isNew || oldPath === null) {
        if (newPath === null) return;
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.startsWith('+')) plus.push(b.slice(1));
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (sectionNoFinal(sec.hunks) ? '' : '\n'));
        return;
      }
      if (sec.isDeleted || newPath === null) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const { br, lines: fileLines, final } = splitFile(before);
        const text = applyHunks(fileLines, br, final, sec.hunks, strict, oldPath);
        tree.now.set(newPath, text);
        tree.now.set(oldPath, null);
        tree.moves.push({ from: oldPath, to: newPath });
        return;
      }
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const { br, lines: fileLines, final } = splitFile(before);
      tree.now.set(oldPath, applyHunks(fileLines, br, final, sec.hunks, strict, oldPath));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const old = lines.slice(searchLine + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { br, lines: fileLines, final } = splitFile(before);
      const found = findTier(fileLines, old, strict, 0, false);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repLines = buildReplacement(fileLines, pos, old, nw, nw.map(() => false), nw.map(() => -1), found.tier);
      const out = [...fileLines];
      out.splice(pos, old.length, ...repLines);
      tree.now.set(p, joinFile(out, br, final));
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
  O: string[];
  N: string[];
  nCtx: boolean[];
  nCtxIdx: number[];
}

function buildVChunk(anchor: string | null, body: string[], eof: boolean): VChunk {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: boolean[] = [];
  const nCtxIdx: number[] = [];
  for (const b of body) {
    if (b.startsWith(' ') || b === '') {
      const t = b === '' ? '' : b.slice(1);
      O.push(t);
      N.push(t);
      nCtx.push(true);
      nCtxIdx.push(O.length - 1);
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push(b.slice(1));
      nCtx.push(false);
      nCtxIdx.push(-1);
    }
  }
  return { anchor, body, eof, O, N, nCtx, nCtxIdx };
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines?: string[];
  moveTo?: string | null;
  chunks?: VChunk[];
}

function parseV4AChunks(content: Array<{ text: string; line: number }>, headerLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < content.length && content[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = content[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(buildVChunk(cur.anchor, cur.body, cur.eof));
      cur = null;
    }
  };
  for (; idx < content.length; idx++) {
    const { text, line } = content[idx]!;
    if (text.startsWith('@@')) {
      close();
      cur = { anchor: text.slice(2).trim() || null, body: [], eof: false };
    } else if (text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${line}`);
      cur.eof = true;
      close();
    } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${line}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(text);
    } else {
      throw new Exit2(`error: parse ${line}`);
    }
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { moveTo, chunks };
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last && blank(lines[i]!)) i++;
  while (i < last) {
    const h = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (h.startsWith('*** Add File: ')) {
      kind = 'add';
      path = h.slice('*** Add File: '.length).trim();
    } else if (h.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = h.slice('*** Delete File: '.length).trim();
    } else if (h.startsWith('*** Update File: ')) {
      kind = 'update';
      path = h.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const content: Array<{ text: string; line: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push({ text: l, line: i + 1 });
      i++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) addLines.push(c.text.slice(1));
        else if (c.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${c.line}`);
      }
      sections.push({ kind, path, headerLine, addLines });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.line}`);
      sections.push({ kind, path, headerLine });
    } else {
      const { moveTo, chunks } = parseV4AChunks(content, headerLine);
      sections.push({ kind, path, headerLine, moveTo, chunks });
    }
    while (i < last && blank(lines[i]!)) i++;
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((sec) => {
    if (sec.kind === 'add') {
      const addLines = sec.addLines!;
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    const moveTo = sec.moveTo ?? null;
    const chunks = sec.chunks!;
    return (tree: Tree): void => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const { br, lines: fileLines, final } = splitFile(before);
      let cur = [...fileLines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const at = anchorLine(cur, ch.anchor, strict, cursor);
          if (at === null) throw new Fail('no-match', sec.path);
          cursor = at + 1;
        }
        if (ch.O.length === 0) {
          const at = ch.eof ? cur.length : cursor;
          cur.splice(at, 0, ...ch.N);
          cursor = at + ch.N.length;
        } else {
          const found = findTier(cur, ch.O, strict, cursor, ch.eof);
          if (!found) throw new Fail('no-match', sec.path);
          const pos = found.positions[0]!;
          const rep = buildReplacement(cur, pos, ch.O, ch.N, ch.nCtx, ch.nCtxIdx, found.tier);
          cur.splice(pos, ch.O.length, ...rep);
          cursor = pos + rep.length;
        }
      }
      const text = joinFile(cur, br, final);
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(sec.path, null);
        tree.moves.push({ from: sec.path, to: moveTo });
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

// ---- Running the patch (SPEC.md sections 1, 2 and 10) ----

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A move that succeeded, where the old path existed before the patch and does not after it and the new path
  // did not exist before it and does after it, is one `R <old> -> <new>` line, replacing that pair's D and A
  // lines and sorting by <new> among the other rows.
  const movedFrom = new Map<string, string>();
  const movedTo = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.original(m.to) === null && tree.now.get(m.from) === null && tree.now.get(m.to) !== null) {
      movedFrom.set(m.from, m.to);
      movedTo.set(m.to, m.from);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of changed) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [from, to] of movedFrom) rows.push({ key: to, line: `R ${from} -> ${to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
