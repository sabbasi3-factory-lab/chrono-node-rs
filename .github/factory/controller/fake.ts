// In-memory fake of the GitHub API used by tests and by `--fixture` mode.
// It implements the Git Data endpoints the audit writer needs, plus any
// read routes a test registers, and records every call (method + path).

import { createHash } from 'node:crypto';
import { GitHubApiError } from './github.ts';
import type { ApiResponse, GitHubClient, HttpMethod, RequestOptions } from './types.ts';

export interface RecordedCall {
  method: HttpMethod;
  path: string;
  body: unknown;
}

export interface RouteResult {
  status?: number;
  data: unknown;
  next?: string | null;
}

export interface Route {
  method: HttpMethod;
  /** Matched against the path without its query string. */
  path: RegExp;
  handler: (path: string, body: unknown) => RouteResult;
}

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

export class FakeGitHub implements GitHubClient {
  readonly repo: string;
  readonly calls: RecordedCall[] = [];
  readonly routes: Route[] = [];
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  /** Number of upcoming ref updates to reject with 422 (simulated races). */
  conflicts = 0;
  /** Runs once before the next ref update (to simulate a concurrent writer). */
  beforeRefUpdate: (() => Promise<void>) | null = null;
  private counter = 0;

  constructor(repo: string) {
    this.repo = repo;
  }

  addRoute(method: HttpMethod, path: RegExp, handler: Route['handler']): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  /** Content of `path` at the head of `branch`, or null. */
  fileAt(branch: string, path: string): string | null {
    const head = this.refs.get(`heads/${branch}`);
    if (!head) return null;
    const tree = this.trees.get(this.commits.get(head)!.tree)!;
    const blob = tree.get(path);
    return blob ? this.blobs.get(blob)! : null;
  }

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    this.calls.push({ method, path, body: options.body === undefined ? undefined : structuredClone(options.body) });
    const res = await this.handle(method, path, options);
    const status = res.status ?? 200;
    if (status >= 300) {
      if (options.allowStatuses?.includes(status)) return { status, data: null, next: null };
      throw new GitHubApiError(status, `${method} ${path.split('?')[0]}: HTTP ${status}`);
    }
    return { status, data: res.data, next: res.next ?? null };
  }

  private async handle(method: HttpMethod, path: string, options: RequestOptions): Promise<RouteResult> {
    const [p = '', query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    const git = `/repos/${this.repo}/git`;
    const body = (options.body ?? {}) as Record<string, unknown>;

    if (method === 'GET' && p.startsWith(`${git}/ref/`)) {
      const name = p.slice(`${git}/ref/`.length);
      const sha = this.refs.get(name);
      return sha ? { data: { ref: `refs/${name}`, object: { sha, type: 'commit' } } } : { status: 404, data: null };
    }
    if (method === 'GET' && p.startsWith(`${git}/commits/`)) {
      const sha = p.slice(`${git}/commits/`.length);
      const c = this.commits.get(sha);
      if (!c) return { status: 404, data: null };
      return { data: { sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })) } };
    }
    if (method === 'GET' && p.startsWith(`/repos/${this.repo}/contents/`) && params.has('ref')) {
      const file = decodeURIComponent(p.slice(`/repos/${this.repo}/contents/`.length));
      const c = this.commits.get(params.get('ref')!);
      if (!c) return { status: 404, data: null };
      const blob = this.trees.get(c.tree)!.get(file);
      if (!blob) return { status: 404, data: null };
      if (options.accept !== 'raw') throw new Error('fake only serves raw contents');
      return { data: this.blobs.get(blob)! };
    }
    if (method === 'POST' && p === `${git}/blobs`) {
      const content = String(body.content);
      const sha = sha1(`blob ${content}`);
      this.blobs.set(sha, content);
      return { status: 201, data: { sha } };
    }
    if (method === 'POST' && p === `${git}/trees`) {
      const base = typeof body.base_tree === 'string' ? this.trees.get(body.base_tree) : undefined;
      if (body.base_tree !== undefined && !base) return { status: 422, data: null };
      const tree = new Map(base ?? []);
      for (const e of body.tree as { path: string; sha: string }[]) tree.set(e.path, e.sha);
      const sha = sha1(`tree ${JSON.stringify([...tree].sort())}`);
      this.trees.set(sha, tree);
      return { status: 201, data: { sha } };
    }
    if (method === 'POST' && p === `${git}/commits`) {
      const commit: Commit = { tree: String(body.tree), parents: body.parents as string[], message: String(body.message) };
      const sha = sha1(`commit ${JSON.stringify(commit)} ${this.counter++}`);
      this.commits.set(sha, commit);
      return { status: 201, data: { sha } };
    }
    if (method === 'POST' && p === `${git}/refs`) {
      const name = String(body.ref).replace(/^refs\//, '');
      if (this.beforeRefUpdate) {
        const hook = this.beforeRefUpdate;
        this.beforeRefUpdate = null;
        await hook();
      }
      if (this.refs.has(name)) return { status: 422, data: null };
      this.refs.set(name, String(body.sha));
      return { status: 201, data: { ref: `refs/${name}` } };
    }
    if (method === 'PATCH' && p.startsWith(`${git}/refs/`)) {
      const name = p.slice(`${git}/refs/`.length);
      if (this.beforeRefUpdate) {
        const hook = this.beforeRefUpdate;
        this.beforeRefUpdate = null;
        await hook();
      }
      if (this.conflicts > 0) {
        this.conflicts--;
        return { status: 422, data: null };
      }
      const current = this.refs.get(name);
      const next = this.commits.get(String(body.sha));
      if (!current || !next) return { status: 422, data: null };
      if (body.force !== false || next.parents[0] !== current) return { status: 422, data: null };
      this.refs.set(name, String(body.sha));
      return { data: { ref: `refs/${name}` } };
    }
    for (const r of this.routes) {
      if (r.method === method && r.path.test(p)) return r.handler(path, options.body);
    }
    return { status: 404, data: null };
  }
}
