// Builders for test snapshots. Not a test file itself.

import { createHash } from 'node:crypto';
import { loadPoliciesFromDir } from '../policies.ts';
import type { CheckRunSnap, ContractSnap, IssueSnap, Policies, PullSnap, Snapshot, TaskHistory } from '../types.ts';

export const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
export const NOW = new Date('2026-10-16T12:00:00Z');

export async function testPolicies(): Promise<Policies> {
  return loadPoliciesFromDir(new URL('./fixtures/policies/', import.meta.url));
}

export function hex40(c: string): string {
  return c.repeat(40).slice(0, 40);
}

/** Deterministic fake contract commit SHA for a task id. */
export function commitSha(id: string): string {
  return createHash('sha1').update(id).digest('hex');
}

export function issue(n: number, task: string | null, labels: string[] = ['factory:ready']): IssueSnap {
  return { number: n, node_id: `I_${n}`, labels, task_id: task, marker_status: task ? 'ok' : 'missing' };
}

export function contract(id: string, over: Partial<ContractSnap> = {}): ContractSnap {
  return {
    path: `contracts/${id}.yaml`,
    blob_sha: hex40('b'),
    last_commit_sha: commitSha(id),
    valid: true,
    id,
    tier: 'auto',
    depends_on: [],
    scope: [`src/locales/en/parsers/${id.split('/').pop()!.replace(/-/g, '_')}.rs`],
    priority: null,
    area: null,
    ...over,
  };
}

export function pull(n: number, over: Partial<PullSnap> = {}): PullSnap {
  return {
    number: n,
    node_id: `PR_${n}`,
    state: 'open',
    draft: false,
    author: 'sabbasi3-factory-agent[bot]',
    author_is_bot: true,
    head_sha: hex40(String(n % 10)),
    created_at: '2026-10-16T08:00:00Z',
    merged_at: null,
    merge_commit_sha: null,
    labels: [],
    task_id: null,
    contract_sha: null,
    attempt: null,
    reviews: [],
    merge_queue_events: [],
    ...over,
  };
}

export function mergedPull(n: number, task: string): PullSnap {
  return pull(n, {
    state: 'merged',
    task_id: task,
    merged_at: '2026-10-15T08:00:00Z',
    created_at: '2026-10-15T07:00:00Z',
    merge_commit_sha: hex40('f'),
  });
}

export function checkRun(id: number, over: Partial<CheckRunSnap> = {}): CheckRunSnap {
  const head = over.head_sha ?? hex40('0');
  return {
    run_id: id,
    run_attempt: 1,
    workflow: 'ci',
    event: 'pull_request',
    head_sha: head,
    candidate_sha: head,
    pull_requests: [],
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-10-16T11:00:00Z',
    updated_at: '2026-10-16T11:10:00Z',
    // A finished ci run normally carries its revealed held-out seed; tests about a missing seed set null.
    heldout_seed: '42',
    failure_signature: null,
    ...over,
  };
}

export function history(over: Partial<TaskHistory> = {}): TaskHistory {
  return { picked_at: null, repairs: 0, failure_signatures: [], repaired_run_ids: [], aic_spent: 0, ...over };
}

export type SnapshotOverrides = Partial<Snapshot> & { contractList?: ContractSnap[] };

export function snapshot(over: SnapshotOverrides = {}): Snapshot {
  const { contractList, ...rest } = over;
  const contracts: Record<string, ContractSnap> = {};
  for (const c of contractList ?? []) contracts[c.path] = c;
  return {
    repo: REPO,
    fetched_at: '2026-10-16T12:00:00Z',
    issues: [],
    pulls: [],
    main_sha: hex40('a'),
    contracts,
    check_runs: [],
    unchecked_heads: [],
    busy_jobs: 0,
    factory_aic_today: 0,
    history: {},
    ...rest,
  };
}
