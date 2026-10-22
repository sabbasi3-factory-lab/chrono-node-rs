// Project #1 "Factory status" sync (live only). A projection of task state onto the org Project,
// for people: the audit log stays the record. Each run compares every task item's current
// status with the status its issue, PRs and labels imply, and sets the ones that differ, so a
// failed update is simply redone next poll. It never adds or removes Project items.
//
//   Proposed → Ready → Building → Checks → Live, and Needs you
//
// Best-effort: a sync failure is logged and shown in the run summary, but never fails the run
// (the planner and the effects don't depend on the Project).

import { FACTORY_PROJECT_NUMBER, FACTORY_STATUS_FIELD, graphql, PROJECT_STATUS_MUTATION } from './github.ts';
import { LABEL_NEEDS_HUMAN, LABEL_PICKED, LABEL_READY } from './planner.ts';
import { parseTaskMarker } from './tasks.ts';
import type { Decision, GitHubClient, Snapshot } from './types.ts';

export const FACTORY_STATUSES = ['Proposed', 'Ready', 'Building', 'Checks', 'Needs you', 'Live'] as const;
export type FactoryStatus = (typeof FACTORY_STATUSES)[number];

/** Labels that mean a person has the task (the controller's hand-offs). */
export const HANDOFF_LABELS: readonly string[] = [LABEL_NEEDS_HUMAN, 'blocked', 'stale-contract'];

export const MAX_PROJECT_PAGES = 20;

export interface ProjectItem {
  item_id: string;
  /** Current option name of "Factory status"; null when unset. */
  status: string | null;
  issue: number;
  open: boolean;
  labels: string[];
  task_id: string | null;
}

export interface ProjectState {
  project_id: string;
  field_id: string;
  /** Option name → option id. */
  options: Record<string, string>;
  items: ProjectItem[];
}

export interface StatusChange {
  item_id: string;
  issue: number;
  task: string;
  from: string | null;
  to: FactoryStatus;
}

export const PROJECT_QUERY = `query($org: String!, $number: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      field(name: "${FACTORY_STATUS_FIELD}") { __typename ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "${FACTORY_STATUS_FIELD}") { __typename ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content { __typename ... on Issue { number state body repository { nameWithOwner } labels(first: 100) { nodes { name } } } }
        }
      }
    }
  }
}`;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Project #1 and its items that are issues of `repo` (other repos' items are ignored). */
export async function readProject(client: GitHubClient, repo: string, number = FACTORY_PROJECT_NUMBER): Promise<ProjectState> {
  const org = repo.split('/')[0]!;
  let state: ProjectState | null = null;
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PROJECT_PAGES) throw new Error('project: too many item pages');
    const project = asRec(asRec(asRec(await graphql(client, PROJECT_QUERY, { org, number, cursor })).organization).projectV2);
    const id = asStr(project.id);
    if (!id) throw new Error(`project ${number} not found`);
    if (!state) {
      const field = asRec(project.field);
      const fieldId = asStr(field.id);
      if (field.__typename !== 'ProjectV2SingleSelectField' || !fieldId) throw new Error(`project field "${FACTORY_STATUS_FIELD}" not found`);
      const options: Record<string, string> = {};
      for (const o of asArr(field.options)) {
        const name = asStr(asRec(o).name);
        const oid = asStr(asRec(o).id);
        if (name && oid) options[name] = oid;
      }
      state = { project_id: id, field_id: fieldId, options, items: [] };
    }
    const items = asRec(project.items);
    for (const n of asArr(items.nodes)) {
      const node = asRec(n);
      const content = asRec(node.content);
      const itemId = asStr(node.id);
      if (!itemId || content.__typename !== 'Issue' || asStr(asRec(content.repository).nameWithOwner) !== repo) continue;
      const num = content.number;
      if (typeof num !== 'number' || !Number.isSafeInteger(num) || num <= 0) continue;
      const value = asRec(node.fieldValueByName);
      state.items.push({
        item_id: itemId,
        status: value.__typename === 'ProjectV2ItemFieldSingleSelectValue' ? asStr(value.name) : null,
        issue: num,
        open: content.state === 'OPEN',
        labels: asArr(asRec(content.labels).nodes).map((l) => asStr(asRec(l).name) ?? '').filter((x) => x !== ''),
        task_id: parseTaskMarker(asStr(content.body)).task_id,
      });
    }
    const info = asRec(items.pageInfo);
    if (info.hasNextPage !== true) break;
    cursor = asStr(info.endCursor);
    if (!cursor) throw new Error('project: missing cursor');
  }
  return state!;
}

export interface StatusContext {
  /** Tasks with a merged PR. */
  merged: Set<string>;
  /** Task → labels of its open PR(s) (present when the task has an open PR). */
  openPrLabels: Map<string, string[]>;
}

/**
 * The status a task item should have, or null when the controller leaves it alone (not a
 * factory task, or an issue closed without its task merged: a person closed it).
 */
export function desiredStatus(item: Pick<ProjectItem, 'open' | 'labels' | 'task_id'>, ctx: StatusContext): FactoryStatus | null {
  const task = item.task_id;
  if (!task) return null;
  if (ctx.merged.has(task)) return 'Live';
  if (!item.open) return null;
  const prLabels = ctx.openPrLabels.get(task);
  if ([...item.labels, ...(prLabels ?? [])].some((l) => HANDOFF_LABELS.includes(l))) return 'Needs you';
  if (prLabels) return 'Checks';
  if (item.labels.includes(LABEL_PICKED)) return 'Building';
  if (item.labels.includes(LABEL_READY)) return 'Ready';
  return 'Proposed';
}

/**
 * Context from the run's snapshot, plus the labels this run's live decisions added to PRs (the
 * Project is read after the effects, so issue labels are already current; PR labels are not).
 */
export function statusContext(s: Snapshot, decisions: Decision[]): StatusContext {
  const merged = new Set<string>();
  const openPrLabels = new Map<string, string[]>();
  const added = new Map<number, string[]>();
  for (const d of decisions) {
    if (d.pr === null || !d.effect.startsWith('label:')) continue;
    added.set(d.pr, [...(added.get(d.pr) ?? []), d.effect.slice('label:'.length)]);
  }
  for (const pr of s.pulls) {
    if (!pr.task_id) continue;
    if (pr.state === 'merged') merged.add(pr.task_id);
    if (pr.state === 'open') openPrLabels.set(pr.task_id, [...(openPrLabels.get(pr.task_id) ?? []), ...pr.labels, ...(added.get(pr.number) ?? [])]);
  }
  return { merged, openPrLabels };
}

export function planStatusChanges(p: ProjectState, ctx: StatusContext): StatusChange[] {
  const out: StatusChange[] = [];
  for (const it of [...p.items].sort((a, b) => a.issue - b.issue)) {
    const to = desiredStatus(it, ctx);
    if (to === null || to === it.status) continue;
    out.push({ item_id: it.item_id, issue: it.issue, task: it.task_id!, from: it.status, to });
  }
  return out;
}

export interface SyncResult {
  changes: StatusChange[];
  applied: number;
  error: string | null;
}

/** Reads the Project, then (live) sets each status that differs. Never throws. */
export async function syncProject(client: GitHubClient, repo: string, ctx: StatusContext, live: boolean, log: (line: string) => void): Promise<SyncResult> {
  const result: SyncResult = { changes: [], applied: 0, error: null };
  try {
    const p = await readProject(client, repo);
    result.changes = planStatusChanges(p, ctx);
    for (const c of result.changes) {
      const option = p.options[c.to];
      const line = `#${c.issue} ${c.task}: ${c.from ?? '(unset)'} → ${c.to}`;
      if (!option) throw new Error(`project has no "${c.to}" option`);
      if (!live) {
        log(`[dry-run] would set Factory status ${line}`);
        continue;
      }
      const res = await client.request('POST', '/graphql', { body: { query: PROJECT_STATUS_MUTATION, variables: { project: p.project_id, item: c.item_id, field: p.field_id, option } } });
      const body = res.data as { errors?: unknown[]; data?: { updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: unknown } } } } | null;
      if (!body || (body.errors && body.errors.length > 0) || typeof body.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== 'string') throw new Error(`status update for #${c.issue} failed`);
      result.applied++;
      log(`[live] Factory status ${line}`);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log(`project sync stopped (retried next poll): ${result.error}`);
  }
  return result;
}
