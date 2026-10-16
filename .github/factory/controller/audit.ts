// Append-only, hash-chained audit log on the protected `audit` branch
// (DESIGN §11). One event = one canonical JSON line = one commit, written
// through the Git Data API with fast-forward-only ref updates.

import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from './canonical.ts';
import type { AuditEvent, GitHubClient, Json, JsonObject, PendingEvent } from './types.ts';

export const AUDIT_BRANCH = 'audit';
export const EVENT_VERSION = 1;
export const DEFAULT_HISTORY_DAYS = 7;
export const MAX_APPEND_RETRIES = 3;

const EVENT_FIELDS = ['id', 'parents', 'payload', 'sha', 'timestamp', 'type', 'version'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const EVENT_TYPE = /^[a-z][a-z_]{0,63}$/;
const AUDIT_PATH = /^audit\/\d{4}\/\d{2}\/\d{2}\.jsonl$/;
// Payload strings may only be IDs, SHAs, logins, enums, timestamps, task ids.
// No spaces, so free text (titles, bodies, comments) cannot slip through.
const SAFE_STRING = /^[A-Za-z0-9._:/#@[\]+-]{0,200}$/;
const RESERVED_PAYLOAD_KEYS = ['dedupe_key', 'factory_version', 'dry_run'];

/** An event failed validation; nothing was written for it. */
export class AuditValidationError extends Error {}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** UTC ISO 8601 with second precision, e.g. `2026-10-16T14:03:11Z`. */
export function isoSeconds(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid date');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `audit/YYYY/MM/DD.jsonl` for the UTC date of a timestamp. */
export function auditPathFor(timestamp: string | Date): string {
  const iso = typeof timestamp === 'string' ? timestamp : isoSeconds(timestamp);
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (!m) throw new RangeError(`not an ISO timestamp: ${iso}`);
  return `audit/${m[1]}/${m[2]}/${m[3]}.jsonl`;
}

/** sha256 over `type|id1|id2…` with the source IDs sorted (UTF-16 order). */
export function dedupeKey(type: string, sourceIds: string[]): string {
  if (!EVENT_TYPE.test(type)) throw new Error(`invalid event type: ${type}`);
  if (sourceIds.length === 0) throw new Error(`dedupe key for ${type} needs at least one source id`);
  for (const id of sourceIds) {
    if (typeof id !== 'string' || id.length === 0 || id.includes('|')) {
      throw new Error(`invalid source id for ${type}: ${String(id)}`);
    }
  }
  const sorted = [...sourceIds].sort();
  return `sha256:${sha256Hex([type, ...sorted].join('|'))}`;
}

export function assertSafePayload(value: Json, at = 'payload'): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${at}: non-finite number`);
    return;
  }
  if (typeof value === 'string') {
    if (!SAFE_STRING.test(value)) throw new Error(`${at}: string is not an ID/enum/SHA/timestamp`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafePayload(v, `${at}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) throw new Error(`${at}: invalid key ${k}`);
    assertSafePayload(v, `${at}.${k}`);
  }
}

export function computeEventSha(record: Omit<AuditEvent, 'sha'>): string {
  return `sha256:${sha256Hex(canonicalize(record))}`;
}

export interface BuildEventInput {
  type: string;
  timestamp: string;
  parents: string[];
  payload: JsonObject;
  id?: string;
}

export function buildEvent(input: BuildEventInput): AuditEvent {
  const record = {
    version: EVENT_VERSION as 1,
    id: input.id ?? randomUUID(),
    type: input.type,
    timestamp: input.timestamp,
    parents: input.parents,
    payload: input.payload,
  };
  validateRecordShape(record);
  return { ...record, sha: computeEventSha(record) };
}

function validateRecordShape(r: Omit<AuditEvent, 'sha'>): void {
  if (r.version !== EVENT_VERSION) throw new Error('version must be 1');
  if (!UUID_V4.test(r.id)) throw new Error('id must be a lowercase UUID v4');
  if (!EVENT_TYPE.test(r.type)) throw new Error('invalid type');
  if (!TIMESTAMP.test(r.timestamp) || isoSeconds(new Date(r.timestamp)) !== r.timestamp) {
    throw new Error('timestamp must be UTC ISO 8601 with second precision');
  }
  if (!Array.isArray(r.parents) || r.parents.length > 1 || !r.parents.every((p) => SHA.test(p))) {
    throw new Error('parents must be [] or ["sha256:<hex>"]');
  }
  if (r.payload === null || typeof r.payload !== 'object' || Array.isArray(r.payload)) {
    throw new Error('payload must be an object');
  }
  if (typeof r.payload.dedupe_key !== 'string' || !SHA.test(r.payload.dedupe_key)) {
    throw new Error('payload.dedupe_key missing');
  }
  if (typeof r.payload.factory_version !== 'string') throw new Error('payload.factory_version missing');
  if (typeof r.payload.dry_run !== 'boolean') throw new Error('payload.dry_run missing');
}

/** Parses one log line, checking shape, canonical form and its own sha. */
export function parseEventLine(line: string): AuditEvent {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('event is not an object');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== EVENT_FIELDS.join(',')) throw new Error('event has wrong fields');
  const event = parsed as AuditEvent;
  const { sha, ...record } = event;
  validateRecordShape(record);
  if (canonicalize(event) !== line) throw new Error('event line is not canonical JSON');
  if (computeEventSha(record) !== sha) throw new Error('sha mismatch');
  return event;
}

export type VerifyResult = { ok: true; events: AuditEvent[] } | { ok: false; index: number; error: string };

/**
 * Recomputes every sha and checks the parent chain. Returns the index of the
 * first broken line. `expectedFirstParent` pins the parent of line 0 (null =
 * genesis, undefined = don't check).
 */
export function verify(lines: string[], expectedFirstParent?: string | null): VerifyResult {
  const events: AuditEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    let event: AuditEvent;
    try {
      event = parseEventLine(lines[i] ?? '');
    } catch (err) {
      return { ok: false, index: i, error: (err as Error).message };
    }
    const prev = events[i - 1];
    if (prev) {
      if (event.parents.length !== 1 || event.parents[0] !== prev.sha) {
        return { ok: false, index: i, error: 'parent does not match previous event' };
      }
      if (event.timestamp < prev.timestamp) {
        return { ok: false, index: i, error: 'timestamp earlier than previous event' };
      }
    } else if (expectedFirstParent !== undefined) {
      const want = expectedFirstParent === null ? [] : [expectedFirstParent];
      if (event.parents.length !== want.length || event.parents[0] !== want[0]) {
        return { ok: false, index: i, error: 'first event has unexpected parent' };
      }
    }
    events.push(event);
  }
  return { ok: true, events };
}

export function splitLines(content: string): string[] {
  if (content === '') return [];
  if (!content.endsWith('\n')) throw new Error('audit file does not end with a newline');
  return content.slice(0, -1).split('\n');
}

export function commitMessage(type: string, sha: string, path: string): string {
  return `audit: ${type} ${sha} ${path}`;
}

export function parseCommitMessage(message: string): { type: string; sha: string; path: string } | null {
  const first = message.split('\n', 1)[0] ?? '';
  const m = /^audit: ([a-z][a-z_]{0,63}) (sha256:[0-9a-f]{64}) (audit\/\d{4}\/\d{2}\/\d{2}\.jsonl)$/.exec(first);
  if (!m) return null;
  return { type: m[1]!, sha: m[2]!, path: m[3]! };
}

/** Day file paths for `now` and the `days - 1` days before it, oldest first. */
export function recentDayPaths(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let d = days - 1; d >= 0; d--) {
    out.push(auditPathFor(new Date(now.getTime() - d * 86_400_000)));
  }
  return out;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function obj(data: unknown, what: string): Record<string, unknown> {
  if (data === null || typeof data !== 'object') throw new Error(`unexpected ${what} response`);
  return data as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`missing ${what}`);
  return value;
}

export interface AuditLogOptions {
  repo: string;
  factoryVersion: string;
  historyDays?: number;
  maxRetries?: number;
}

/**
 * Reader/writer for the audit branch. `load()` reads the recent day files at
 * the branch head and verifies the chain; `append()` adds one event per commit.
 */
export class AuditLog {
  private readonly client: GitHubClient;
  private readonly repo: string;
  private readonly factoryVersion: string;
  private readonly historyDays: number;
  private readonly maxRetries: number;
  private head: { sha: string; tree: string } | null = null;
  private files = new Map<string, string>();
  private keys = new Set<string>();
  private loaded = false;
  events: AuditEvent[] = [];
  readonly appended: AuditEvent[] = [];

  constructor(client: GitHubClient, options: AuditLogOptions) {
    this.client = client;
    this.repo = options.repo;
    this.factoryVersion = options.factoryVersion;
    this.historyDays = Math.max(2, options.historyDays ?? DEFAULT_HISTORY_DAYS);
    this.maxRetries = options.maxRetries ?? MAX_APPEND_RETRIES;
  }

  hasDedupeKey(key: string): boolean {
    return this.keys.has(key);
  }

  dedupeKeys(): ReadonlySet<string> {
    return this.keys;
  }

  newestOfType(type: string): AuditEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.type === type) return this.events[i]!;
    }
    return null;
  }

  async load(now: Date): Promise<void> {
    this.head = null;
    this.files = new Map();
    this.keys = new Set();
    this.events = [];
    const ref = await this.client.request('GET', `/repos/${this.repo}/git/ref/heads/${AUDIT_BRANCH}`, {
      allowStatuses: [404],
    });
    if (ref.status === 404) {
      this.loaded = true;
      return;
    }
    const headSha = str(obj(obj(ref.data, 'ref').object, 'ref').sha, 'audit head sha');
    const commit = obj((await this.client.request('GET', `/repos/${this.repo}/git/commits/${headSha}`)).data, 'commit');
    const treeSha = str(obj(commit.tree, 'commit tree').sha, 'tree sha');
    const parsed = parseCommitMessage(str(commit.message, 'commit message'));
    if (!parsed) throw new Error('audit head commit message is not an audit commit; refusing to append');

    const paths = new Set(recentDayPaths(now, this.historyDays));
    paths.add(parsed.path);
    const ordered = [...paths].sort();
    const lines: string[] = [];
    for (const path of ordered) {
      const content = await this.readFile(path, headSha);
      this.files.set(path, content);
      lines.push(...splitLines(content));
    }
    const result = verify(lines);
    if (!result.ok) throw new Error(`audit chain broken at loaded line ${result.index}: ${result.error}`);
    const last = result.events.at(-1);
    if (!last || last.sha !== parsed.sha) {
      throw new Error('audit head commit does not point at the last event; refusing to append');
    }
    this.head = { sha: headSha, tree: treeSha };
    this.events = result.events;
    for (const e of result.events) this.keys.add(e.payload.dedupe_key as string);
    this.loaded = true;
  }

  private async readFile(path: string, ref: string): Promise<string> {
    if (!AUDIT_PATH.test(path)) throw new Error(`invalid audit path ${path}`);
    const res = await this.client.request('GET', `/repos/${this.repo}/contents/${encodePath(path)}?ref=${ref}`, {
      accept: 'raw',
      allowStatuses: [404],
    });
    if (res.status === 404) return '';
    if (typeof res.data !== 'string') throw new Error(`unexpected content for ${path}`);
    return res.data;
  }

  /**
   * Validates an event before anything is written. Every failure is an
   * AuditValidationError, so the caller can skip this one event and go on.
   */
  prepare(pending: PendingEvent): { key: string; payload: JsonObject } {
    try {
      const key = dedupeKey(pending.type, pending.source_ids);
      for (const k of RESERVED_PAYLOAD_KEYS) {
        if (k in pending.fields) throw new Error(`payload field ${k} is reserved`);
      }
      const payload: JsonObject = {
        ...pending.fields,
        dedupe_key: key,
        factory_version: this.factoryVersion,
        dry_run: true,
      };
      assertSafePayload(payload);
      canonicalize(payload);
      return { key, payload };
    } catch (err) {
      throw new AuditValidationError(`${pending.type}: ${(err as Error).message}`);
    }
  }

  /**
   * Appends one event (one commit). Returns null if its dedupe_key already
   * exists. Throws AuditValidationError (before any write) for an invalid event.
   */
  async append(pending: PendingEvent, now: Date): Promise<AuditEvent | null> {
    if (!this.loaded) throw new Error('audit log not loaded');
    const { key, payload } = this.prepare(pending);
    if (this.keys.has(key)) return null;
    const id = randomUUID();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.load(now);
        if (this.keys.has(key)) return null;
      }
      const timestamp = isoSeconds(now);
      const last = this.events.at(-1);
      if (last && timestamp < last.timestamp) throw new Error('clock is behind the last audit event');
      const event = buildEvent({ id, type: pending.type, timestamp, parents: last ? [last.sha] : [], payload });
      const line = canonicalize(event);
      const path = auditPathFor(timestamp);
      const existing = this.files.has(path)
        ? this.files.get(path)!
        : this.head
          ? await this.readFile(path, this.head.sha)
          : '';
      splitLines(existing);
      const content = `${existing}${line}\n`;

      const blob = obj(
        (await this.client.request('POST', `/repos/${this.repo}/git/blobs`, { body: { content, encoding: 'utf-8' } }))
          .data,
        'blob',
      );
      const treeBody: Record<string, unknown> = {
        tree: [{ path, mode: '100644', type: 'blob', sha: str(blob.sha, 'blob sha') }],
      };
      if (this.head) treeBody.base_tree = this.head.tree;
      const tree = obj(
        (await this.client.request('POST', `/repos/${this.repo}/git/trees`, { body: treeBody })).data,
        'tree',
      );
      const treeSha = str(tree.sha, 'tree sha');
      const commit = obj(
        (
          await this.client.request('POST', `/repos/${this.repo}/git/commits`, {
            body: {
              message: commitMessage(event.type, event.sha, path),
              tree: treeSha,
              parents: this.head ? [this.head.sha] : [],
            },
          })
        ).data,
        'commit',
      );
      const commitSha = str(commit.sha, 'commit sha');
      const res = this.head
        ? await this.client.request('PATCH', `/repos/${this.repo}/git/refs/heads/${AUDIT_BRANCH}`, {
            body: { sha: commitSha, force: false },
            allowStatuses: [409, 422],
          })
        : await this.client.request('POST', `/repos/${this.repo}/git/refs`, {
            body: { ref: `refs/heads/${AUDIT_BRANCH}`, sha: commitSha },
            allowStatuses: [409, 422],
          });
      if (res.status === 409 || res.status === 422) continue;

      this.head = { sha: commitSha, tree: treeSha };
      this.files.set(path, content);
      this.events.push(event);
      this.keys.add(key);
      this.appended.push(event);
      return event;
    }
    throw new Error(`audit append of ${pending.type} failed: branch moved ${this.maxRetries + 1} times`);
  }
}
