import { appConfig } from '@/app/config';
import { api, ApiError } from './api';

/**
 * The offline queue.
 *
 * A neighbourhood shop's connection drops constantly, and a shopkeeper mid-sale
 * cannot wait for it. So safe actions are queued locally and replayed on
 * reconnect.
 *
 * The rule that governs every piece of copy this module drives: **a queued
 * action has not been saved.** It is "waiting to sync", never "saved", until
 * the server confirms it. Each entry carries an idempotency key so a replay
 * cannot double-charge, and the server's per-action outcome decides what leaves
 * the queue.
 */

export type QueuedKind = 'transaction' | 'payment' | 'customer';

export type QueuedAction = {
  id: string;
  kind: QueuedKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  queuedAt: string;
  /** What the user sees in the pending list. */
  label: string;
  /** Consecutive failed replays; used to stop retrying a hopeless action. */
  attempts: number;
  /** Set when the server rejected it for a reason retrying will not fix. */
  error?: string;
};

export type SyncOutcome = {
  id: string;
  kind: string;
  status: 'synced' | 'duplicate' | 'failed';
  recordId?: string;
  error?: string;
};

export type SyncResult = {
  synced: number;
  failed: number;
  outcomes: SyncOutcome[];
};

/** Beyond this an action is parked as failed rather than retried forever. */
const MAX_ATTEMPTS = 5;

type Listener = (actions: QueuedAction[]) => void;
const listeners = new Set<Listener>();

function read(): QueuedAction[] {
  try {
    const raw = localStorage.getItem(appConfig.storageKeys.queue);
    return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
  } catch {
    return [];
  }
}

function write(actions: QueuedAction[]): void {
  try {
    localStorage.setItem(appConfig.storageKeys.queue, JSON.stringify(actions));
  } catch {
    // Storage unavailable (private mode, quota). The in-memory notification
    // still fires, so the UI stays correct for this session.
  }
  for (const listener of listeners) listener(actions);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(read());
  return () => listeners.delete(listener);
}

export function getQueue(): QueuedAction[] {
  return read();
}

export function pendingCount(): number {
  return read().filter((action) => !action.error).length;
}

/**
 * Adds an action to the queue.
 *
 * The idempotency key is generated here, once, and reused across every replay
 * attempt — generating it per attempt would defeat the entire mechanism.
 */
export function enqueue(input: {
  kind: QueuedKind;
  payload: Record<string, unknown>;
  label: string;
}): QueuedAction {
  const action: QueuedAction = {
    id: `q_${crypto.randomUUID()}`,
    kind: input.kind,
    idempotencyKey: crypto.randomUUID(),
    payload: input.payload,
    queuedAt: new Date().toISOString(),
    label: input.label,
    attempts: 0,
  };

  write([...read(), action]);
  return action;
}

export function remove(id: string): void {
  write(read().filter((action) => action.id !== id));
}

export function clearFailed(): void {
  write(read().filter((action) => !action.error));
}

let syncing = false;

/**
 * Replays the queue.
 *
 * Returns what actually happened so the UI can report it precisely — "3 actions
 * synced" only when three were genuinely accepted. A duplicate counts as
 * success: the record is safely stored, so the action must leave the queue.
 */
export async function sync(): Promise<SyncResult> {
  if (syncing) return { synced: 0, failed: 0, outcomes: [] };
  if (!navigator.onLine) return { synced: 0, failed: 0, outcomes: [] };

  const pending = read().filter((action) => !action.error && action.attempts < MAX_ATTEMPTS);
  if (pending.length === 0) return { synced: 0, failed: 0, outcomes: [] };

  syncing = true;
  try {
    const response = await api.post<{
      outcomes: SyncOutcome[];
      summary: { total: number; synced: number; failed: number };
    }>('/sync', {
      actions: pending.map((action) => ({
        id: action.id,
        kind: action.kind,
        idempotencyKey: action.idempotencyKey,
        payload: action.payload,
        queuedAt: action.queuedAt,
      })),
    });

    const byId = new Map(response.outcomes.map((outcome) => [outcome.id, outcome]));
    const remaining: QueuedAction[] = [];

    for (const action of read()) {
      const outcome = byId.get(action.id);
      if (!outcome) {
        // Not part of this batch; leave it untouched.
        remaining.push(action);
        continue;
      }
      if (outcome.status === 'synced' || outcome.status === 'duplicate') continue;

      const attempts = action.attempts + 1;
      remaining.push({
        ...action,
        attempts,
        // Park it once retrying is clearly pointless, and keep the reason so
        // the user can see why rather than watching a silent spinner.
        ...(attempts >= MAX_ATTEMPTS
          ? { error: outcome.error ?? 'This could not be saved.' }
          : {}),
      });
    }

    write(remaining);
    return {
      synced: response.summary.synced,
      failed: response.summary.failed,
      outcomes: response.outcomes,
    };
  } catch (error) {
    // Still offline, or the server is unreachable: keep everything queued and
    // do not count an attempt against it.
    if (error instanceof ApiError && error.offline) {
      return { synced: 0, failed: 0, outcomes: [] };
    }

    const bumped = read().map((action) =>
      action.error ? action : { ...action, attempts: action.attempts + 1 },
    );
    write(bumped);
    throw error;
  } finally {
    syncing = false;
  }
}
