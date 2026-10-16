// Daily audit-chain verifier (DESIGN §11). Plain code, no AI, no App key.
//
// It reads the WHOLE `audit` branch (every audit/YYYY/MM/DD.jsonl), recomputes every event's
// sha and the hash chain from the first event, and checks the log against external anchors:
// one comment per verified run on an "Audit chain anchors" issue, written by
// github-actions[bot] (not the controller App, which writes the log). Each anchor pins
// (event count, sha of the last event). Truncating the tail, rewriting history or deleting the
// branch then breaks an earlier anchor, even if the rewritten log is internally consistent.
// Anchor comments also notify watchers by email: a copy outside GitHub.
//
// On success it appends a new anchor; on failure it opens (or comments on) one `audit-alert`
// issue and exits 1. Alert and anchor texts carry only counts, SHAs, paths and dates.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitLines, verify } from './audit.ts';
import type { AuditEvent } from './types.ts';

export const ANCHOR_MARKER = 'factory-audit-anchor v1';
export const ANCHOR_LABEL = 'audit-anchor';
export const ALERT_LABEL = 'audit-alert';
export const ANCHOR_TITLE = 'Audit chain anchors';
export const ALERT_TITLE = 'Audit chain broken';
export const TRUSTED_AUTHOR = 'github-actions[bot]';

const DAY_PATH = /^audit\/(\d{4})\/(\d{2})\/(\d{2})\.jsonl$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface Anchor {
  /** UTC time the verifier ran. */
  at: string;
  /** Number of events in the verified log. */
  events: number;
  /** `sha` of the last event (null for an empty log). */
  last_sha: string | null;
  /** The audit branch commit that was verified (null when the branch didn't exist). */
  audit_head: string | null;
}

export interface LogFile {
  path: string;
  content: string;
}

export function formatAnchor(a: Anchor): string {
  return `${ANCHOR_MARKER}\n\n\`\`\`json\n${JSON.stringify(a)}\n\`\`\`\n`;
}

/** Parses an anchor comment body; null if it isn't exactly an anchor. */
export function parseAnchor(body: string): Anchor | null {
  const m = /^factory-audit-anchor v1\n\n```json\n(\{[^\n]*\})\n```\n?$/.exec(body.replace(/\r\n/g, '\n'));
  if (!m) return null;
  let v: unknown;
  try {
    v = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'at,audit_head,events,last_sha') return null;
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return null;
  if (typeof o.events !== 'number' || !Number.isSafeInteger(o.events) || o.events < 0) return null;
  if (!(o.last_sha === null ? o.events === 0 : typeof o.last_sha === 'string' && SHA.test(o.last_sha) && o.events > 0)) return null;
  if (!(o.audit_head === null || (typeof o.audit_head === 'string' && COMMIT.test(o.audit_head)))) return null;
  return { at: o.at, events: o.events, last_sha: o.last_sha as string | null, audit_head: o.audit_head as string | null };
}

export type FullLogResult = { ok: true; events: AuditEvent[] } | { ok: false; errors: string[] };

/**
 * Verifies the whole log: day-file names, one file per day in date order, every line, every
 * sha, the chain from a genesis event (no parent), and that each event sits in its own day file.
 */
export function verifyFullLog(files: LogFile[]): FullLogResult {
  const errors: string[] = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines: string[] = [];
  const pathOfLine: string[] = [];
  for (const f of sorted) {
    if (!DAY_PATH.test(f.path)) {
      errors.push(`unexpected file ${f.path}`);
      continue;
    }
    let ls: string[];
    try {
      ls = splitLines(f.content);
    } catch (err) {
      errors.push(`${f.path}: ${(err as Error).message}`);
      continue;
    }
    if (ls.length === 0) errors.push(`${f.path}: empty day file`);
    for (const l of ls) {
      lines.push(l);
      pathOfLine.push(f.path);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const r = verify(lines, null);
  if (!r.ok) return { ok: false, errors: [`event #${r.index + 1} (${pathOfLine[r.index]}): ${r.error}`] };
  r.events.forEach((e, i) => {
    const m = DAY_PATH.exec(pathOfLine[i]!)!;
    if (e.timestamp.slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) errors.push(`event #${i + 1} (${e.sha}) is not in its day file ${pathOfLine[i]}`);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, events: r.events };
}

/**
 * Checks the verified log against every earlier anchor (oldest first). The log may only grow:
 * each anchored position must still hold the anchored event, and anchors themselves must
 * never shrink.
 */
export function checkAnchors(events: AuditEvent[], anchors: Anchor[]): string[] {
  const errors: string[] = [];
  let prev: Anchor | null = null;
  for (const a of anchors) {
    if (prev && a.events < prev.events) errors.push(`anchor ${a.at} has fewer events (${a.events}) than the earlier anchor ${prev.at} (${prev.events})`);
    if (a.events > events.length) {
      errors.push(`log shrank: anchor ${a.at} recorded ${a.events} events, the log now has ${events.length}`);
    } else if (a.events > 0 && events[a.events - 1]!.sha !== a.last_sha) {
      errors.push(`history rewritten: event #${a.events} is ${events[a.events - 1]!.sha}, anchor ${a.at} recorded ${a.last_sha}`);
    }
    prev = a;
  }
  return errors;
}

/** Reads every file under `<dir>/audit/` as a LogFile with a repo-relative path. */
export function readLogDir(dir: string): LogFile[] {
  const out: LogFile[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = `${rel}/${name}`;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out.push({ path: r, content: readFileSync(join(dir, r), 'utf8') });
    }
  };
  try {
    if (statSync(join(dir, 'audit')).isDirectory()) walk('audit');
  } catch {
    // no audit/ directory: an empty log
  }
  return out;
}

// ---------------------------------------------------------------- GitHub (issues only)

interface Rest {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** A minimal REST client limited to this repo's issues, comments and labels. */
export function restClient(repo: string, token: string, fetchImpl: typeof fetch = fetch): Rest {
  const allowed = new RegExp(`^/repos/${repo.replace('/', '\\/')}/issues(/\\d+(/comments)?)?(\\?[^#]*)?$`);
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (!allowed.test(path)) throw new Error(`verifier: refusing ${method} ${path}`);
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`verifier: ${method} ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
  };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const login = (v: unknown): string | null => {
  const l = rec(v).login;
  return typeof l === 'string' ? l : null;
};

async function listAll(gh: Rest, path: string): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await gh.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`verifier: ${path}: not a list`);
    out.push(...batch.map(rec));
    if (batch.length < 100) return out;
  }
  throw new Error(`verifier: ${path}: too many pages`);
}

/**
 * Issues with `label` opened by the trusted author. Anyone can open or comment on issues in a
 * public repo, so authorship is checked here, on every issue and comment, not by a query filter.
 */
async function trustedIssues(gh: Rest, repo: string, label: string, state: 'open' | 'all'): Promise<Rec[]> {
  const issues = await listAll(gh, `/repos/${repo}/issues?state=${state}&labels=${label}&sort=created&direction=asc`);
  return issues.filter((i) => login(i.user) === TRUSTED_AUTHOR && i.pull_request === undefined);
}

export interface AnchorRead {
  issue: number | null;
  anchors: Anchor[];
  /** Problems with the anchors themselves (edited comments). */
  errors: string[];
}

export async function readAnchors(gh: Rest, repo: string): Promise<AnchorRead> {
  const issues = await trustedIssues(gh, repo, ANCHOR_LABEL, 'all');
  const anchors: Anchor[] = [];
  const errors: string[] = [];
  for (const issue of issues) {
    const comments = await listAll(gh, `/repos/${repo}/issues/${Number(issue.number)}/comments`);
    for (const c of comments) {
      if (login(c.user) !== TRUSTED_AUTHOR) continue;
      const a = parseAnchor(typeof c.body === 'string' ? c.body : '');
      if (!a) continue;
      if (c.updated_at !== c.created_at) errors.push(`anchor comment ${String(c.id)} was edited after it was written`);
      anchors.push(a);
    }
  }
  anchors.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return { issue: issues.length > 0 ? Number(issues[0]!.number) : null, anchors, errors };
}

export interface VerifyDeps {
  gh: Rest;
  repo: string;
  files: LogFile[];
  /** null when the audit branch doesn't exist. */
  auditHead: string | null;
  now: Date;
  runUrl: string | null;
  log: (line: string) => void;
}

export async function runVerifier(d: VerifyDeps): Promise<{ ok: boolean; errors: string[]; anchor: Anchor | null }> {
  const read = await readAnchors(d.gh, d.repo);
  const errors = [...read.errors];
  let events: AuditEvent[] = [];
  if (d.auditHead === null && read.anchors.some((a) => a.audit_head !== null)) {
    errors.push('the audit branch is gone, but earlier anchors recorded it');
  }
  const full = verifyFullLog(d.files);
  if (full.ok) events = full.events;
  else errors.push(...full.errors);
  if (full.ok) errors.push(...checkAnchors(events, read.anchors));

  const at = d.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (errors.length > 0) {
    for (const e of errors) d.log(`::error::${e}`);
    const body = [`Audit chain verification failed at ${at}.`, '', ...errors.map((e) => `- ${e}`), '', d.runUrl ? `Run: ${d.runUrl}` : ''].join('\n');
    const open = await trustedIssues(d.gh, d.repo, ALERT_LABEL, 'open');
    if (open.length > 0) await d.gh.post(`/repos/${d.repo}/issues/${Number(open[0]!.number)}/comments`, { body });
    else await d.gh.post(`/repos/${d.repo}/issues`, { title: ALERT_TITLE, body, labels: [ALERT_LABEL] });
    return { ok: false, errors, anchor: null };
  }

  const anchor: Anchor = { at, events: events.length, last_sha: events.at(-1)?.sha ?? null, audit_head: d.auditHead };
  if (anchor.events === 0 && read.anchors.length === 0) {
    d.log('audit log is empty and nothing is anchored yet: nothing to do');
    return { ok: true, errors: [], anchor: null };
  }
  let issue = read.issue;
  if (issue === null) {
    const created = rec(
      await d.gh.post(`/repos/${d.repo}/issues`, {
        title: ANCHOR_TITLE,
        body: 'Daily anchors of the audit hash chain, written by the `audit-verify` workflow (DESIGN §11). Do not edit: an edited anchor fails verification.',
        labels: [ANCHOR_LABEL],
      }),
    );
    issue = Number(created.number);
  }
  await d.gh.post(`/repos/${d.repo}/issues/${issue}/comments`, { body: formatAnchor(anchor) });
  d.log(`verified ${anchor.events} events; last ${anchor.last_sha ?? '-'}; anchored on #${issue}`);
  return { ok: true, errors: [], anchor };
}

async function main(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GH_TOKEN ?? '';
  const dir = process.env.AUDIT_DIR ?? '';
  const head = process.env.AUDIT_HEAD ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error('verifier: GITHUB_REPOSITORY and GH_TOKEN are required');
  if (head !== '' && !COMMIT.test(head)) throw new Error('verifier: AUDIT_HEAD must be a commit SHA or empty');
  const server = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  const result = await runVerifier({
    gh: restClient(repo, token),
    repo,
    files: head === '' || dir === '' ? [] : readLogDir(dir),
    auditHead: head === '' ? null : head,
    now: new Date(),
    runUrl: server && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
    log: (l) => console.log(l),
  });
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`::error::${(err as Error).message}`);
    process.exitCode = 1;
  });
}
