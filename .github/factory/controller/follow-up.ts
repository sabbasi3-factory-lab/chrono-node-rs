// A follow-up poll (DESIGN §11 cadence): GitHub's cron runs this repo's "every 5 min" schedule every
// 2–8 h, so while work is in flight (or waiting, or paused for a reason that can clear) the
// controller dispatches one more run of itself. The workflow's `wait` job holds it ~10 min, outside
// the controller's concurrency group, so event-triggered polls are never delayed by it.
//
// Safety: live mode only (FACTORY_ENABLED exactly "true", so never with the kill switch off); never
// when idle or paused by the kill switch; at most FOLLOW_UP_MAX_CHAIN follow-ups in a row (a cron
// or event run starts at 0); never while another dispatched controller run is queued or running (one
// chain at a time); and an unreadable run list means no follow-up (cron is the backstop). A failed
// dispatch is logged, never fatal.

import type { DispatchStatus } from './dispatch-state.ts';
import { CONTROLLER_WORKFLOW, paginate } from './github.ts';
import type { GitHubClient } from './types.ts';

/** Follow-ups in a row before the chain stops (about 4 h at 10 min each). */
export const FOLLOW_UP_MAX_CHAIN = 24;

/** The `chain` workflow input: empty (a cron or event run) is 0; anything else must be 1..MAX, else null. */
export function parseChain(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= FOLLOW_UP_MAX_CHAIN ? n : null;
}

export type FollowUpReason = 'dry_run' | 'invalid_chain' | 'chain_cap' | 'idle' | 'kill_switch' | 'wanted';

export function followUpWanted(status: DispatchStatus, live: boolean, chain: number | null): FollowUpReason {
  if (!live) return 'dry_run';
  if (chain === null) return 'invalid_chain';
  if (chain >= FOLLOW_UP_MAX_CHAIN) return 'chain_cap';
  if (status.state === 'idle') return 'idle';
  if (status.state === 'paused' && status.reason === 'kill_switch') return 'kill_switch';
  return 'wanted';
}

/** Run statuses that mean a dispatched controller run hasn't finished (GitHub's `status` filter values). */
const PENDING = ['queued', 'in_progress', 'waiting', 'pending', 'requested'] as const;
const PENDING_MAX_PAGES = 5;

/** Dispatches the next follow-up poll if wanted; returns what it did (for the log and tests). */
export async function followUp(
  client: GitHubClient, repo: string, runId: number, status: DispatchStatus, live: boolean, chain: number | null, log: (line: string) => void,
): Promise<'dispatched' | 'pending' | 'unknown' | 'failed' | FollowUpReason> {
  const why = followUpWanted(status, live, chain);
  if (why !== 'wanted') {
    log(`follow-up poll: none (${why})`);
    return why;
  }
  // Any dispatched controller run still pending, by status (each list is short, so the page cap is
  // never near; reaching it, or an unreadable page, means no follow-up).
  try {
    for (const status of PENDING) {
      const runs = await paginate(
        client,
        `/repos/${repo}/actions/workflows/${CONTROLLER_WORKFLOW}/runs?event=workflow_dispatch&status=${status}&per_page=100`,
        (d) => {
          const r = (d as { workflow_runs?: unknown })?.workflow_runs;
          if (!Array.isArray(r)) throw new Error('no workflow_runs');
          return r as { id?: unknown }[];
        },
        PENDING_MAX_PAGES,
      );
      const other = runs.find((r) => r.id !== runId);
      if (other) {
        log(`follow-up poll: one is already ${status} (run ${String(other.id)})`);
        return 'pending';
      }
    }
  } catch (err) {
    log(`follow-up poll: none (run list unreadable: ${(err as Error).message})`);
    return 'unknown';
  }
  const next = chain! + 1;
  try {
    await client.request('POST', `/repos/${repo}/actions/workflows/${CONTROLLER_WORKFLOW}/dispatches`, { body: { ref: 'main', inputs: { chain: String(next) } } });
    log(`follow-up poll: dispatched (chain ${next} of ${FOLLOW_UP_MAX_CHAIN}, starts in about 10 min)`);
    return 'dispatched';
  } catch (err) {
    log(`WARNING: follow-up poll not dispatched (${(err as Error).message}); cron is the backstop`);
    return 'failed';
  }
}
