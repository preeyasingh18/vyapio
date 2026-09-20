import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as queue from '@/lib/offlineQueue';
import type { QueuedAction, QueuedKind } from '@/lib/offlineQueue';

/**
 * Connectivity and the sync queue.
 *
 * `navigator.onLine` is necessary but not sufficient — it reports whether a
 * network interface exists, not whether the API is reachable, so a captive
 * portal or a dead backend both read as "online". A failed sync therefore
 * demotes the status back to offline rather than trusting the flag.
 *
 * The contract for every consumer: while an action sits in this queue it is
 * "waiting to sync", never "saved".
 */

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'failed';

type OfflineContextValue = {
  online: boolean;
  pending: QueuedAction[];
  pendingCount: number;
  status: SyncStatus;
  /** Set briefly after a successful sync, for the confirmation toast. */
  lastSyncedCount: number;
  enqueue: (input: { kind: QueuedKind; payload: Record<string, unknown>; label: string }) => void;
  syncNow: () => Promise<void>;
  clearFailed: () => void;
};

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState<QueuedAction[]>(() => queue.getQueue());
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncedCount, setLastSyncedCount] = useState(0);

  // Guards against two syncs overlapping when the browser fires `online` at the
  // same moment a timer ticks.
  const syncing = useRef(false);

  useEffect(() => queue.subscribe(setPending), []);

  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    if (queue.pendingCount() === 0) return;

    syncing.current = true;
    setStatus('syncing');
    try {
      const result = await queue.sync();
      if (result.synced > 0) {
        setLastSyncedCount(result.synced);
        setStatus('synced');
        // Clears the confirmation after it has been read.
        window.setTimeout(() => setStatus('idle'), 4000);
      } else if (result.failed > 0) {
        setStatus('failed');
      } else {
        setStatus('idle');
      }
    } catch {
      // The request itself failed, so we are not really online.
      setStatus('failed');
      setOnline(false);
    } finally {
      syncing.current = false;
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const handleOffline = () => {
      setOnline(false);
      setStatus('idle');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [syncNow]);

  // A periodic retry catches the case the browser never fires an `online`
  // event for — a flaky connection that technically never dropped.
  useEffect(() => {
    if (!online) return;
    const timer = window.setInterval(() => {
      if (queue.pendingCount() > 0) void syncNow();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [online, syncNow]);

  // Drain anything left over from a previous session on first load.
  useEffect(() => {
    if (navigator.onLine && queue.pendingCount() > 0) void syncNow();
  }, [syncNow]);

  const enqueue = useCallback(
    (input: { kind: QueuedKind; payload: Record<string, unknown>; label: string }) => {
      queue.enqueue(input);
      if (navigator.onLine) void syncNow();
    },
    [syncNow],
  );

  const clearFailed = useCallback(() => queue.clearFailed(), []);

  const value = useMemo<OfflineContextValue>(
    () => ({
      online,
      pending,
      pendingCount: pending.filter((action) => !action.error).length,
      status,
      lastSyncedCount,
      enqueue,
      syncNow,
      clearFailed,
    }),
    [online, pending, status, lastSyncedCount, enqueue, syncNow, clearFailed],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const context = useContext(OfflineContext);
  if (!context) throw new Error('useOffline must be used inside OfflineProvider');
  return context;
}
