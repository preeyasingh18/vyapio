import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queue from '@/lib/offlineQueue';
import { api } from '@/lib/api';
import type * as ApiNamespace from '@/lib/api';

/**
 * The offline queue.
 *
 * The tests that matter here are about honesty and safety: an action stays in
 * the queue until the server confirms it, and a replay cannot double-apply.
 */

type ApiModule = typeof ApiNamespace;

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<ApiModule>('@/lib/api');
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

const mockedPost = vi.mocked(api.post);

describe('offline queue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('stores a queued action', () => {
    queue.enqueue({
      kind: 'transaction',
      payload: { customerId: 'cus_1' },
      label: 'Ramesh · ₹120',
    });

    const pending = queue.getQueue();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.label).toBe('Ramesh · ₹120');
    expect(queue.pendingCount()).toBe(1);
  });

  it('gives every action its own idempotency key', () => {
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'two' });

    const [first, second] = queue.getQueue();
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it('keeps the key stable across replays', async () => {
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });
    const original = queue.getQueue()[0]!.idempotencyKey;

    // First attempt fails at the server.
    mockedPost.mockResolvedValueOnce({
      outcomes: [{ id: queue.getQueue()[0]!.id, kind: 'transaction', status: 'failed' }],
      summary: { total: 1, synced: 0, failed: 1 },
    });
    await queue.sync();

    // A regenerated key here would defeat replay protection entirely.
    expect(queue.getQueue()[0]!.idempotencyKey).toBe(original);
  });

  it('removes actions the server accepted', async () => {
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });
    const id = queue.getQueue()[0]!.id;

    mockedPost.mockResolvedValueOnce({
      outcomes: [{ id, kind: 'transaction', status: 'synced', recordId: 'txn_1' }],
      summary: { total: 1, synced: 1, failed: 0 },
    });

    const result = await queue.sync();

    expect(result.synced).toBe(1);
    expect(queue.getQueue()).toHaveLength(0);
  });

  it('treats a duplicate as success and clears it', async () => {
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });
    const id = queue.getQueue()[0]!.id;

    mockedPost.mockResolvedValueOnce({
      outcomes: [{ id, kind: 'transaction', status: 'duplicate' }],
      summary: { total: 1, synced: 1, failed: 0 },
    });

    await queue.sync();

    // The record is safely stored, so leaving it queued would be wrong.
    expect(queue.getQueue()).toHaveLength(0);
  });

  it('keeps a failed action and counts the attempt', async () => {
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });
    const id = queue.getQueue()[0]!.id;

    mockedPost.mockResolvedValueOnce({
      outcomes: [{ id, kind: 'transaction', status: 'failed', error: 'Bad data' }],
      summary: { total: 1, synced: 0, failed: 1 },
    });

    await queue.sync();

    const pending = queue.getQueue();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
  });

  it('parks an action that keeps failing', async () => {
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = queue.getQueue()[0];
      if (!current) break;
      mockedPost.mockResolvedValueOnce({
        outcomes: [{ id: current.id, kind: 'transaction', status: 'failed', error: 'Bad data' }],
        summary: { total: 1, synced: 0, failed: 1 },
      });
      await queue.sync();
    }

    const parked = queue.getQueue()[0];
    expect(parked?.error).toBeDefined();
    // Parked actions stop counting as "waiting to sync".
    expect(queue.pendingCount()).toBe(0);
  });

  it('does not attempt a sync while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    queue.enqueue({ kind: 'transaction', payload: {}, label: 'one' });

    const result = await queue.sync();

    expect(mockedPost).not.toHaveBeenCalled();
    expect(result.synced).toBe(0);
    expect(queue.getQueue()).toHaveLength(1);
  });

  it('notifies subscribers when the queue changes', () => {
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);

    queue.enqueue({ kind: 'payment', payload: {}, label: 'payment' });

    // Once on subscribe, once on change.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0]).toHaveLength(1);

    unsubscribe();
  });

  it('survives a corrupt localStorage value', () => {
    localStorage.setItem('vyapio.offline.queue', 'not json');
    expect(queue.getQueue()).toEqual([]);
  });
});
