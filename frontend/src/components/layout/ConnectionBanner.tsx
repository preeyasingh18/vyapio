import { AnimatePresence, motion } from 'framer-motion';
import { Check, CloudOff, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { useT } from '@/app/providers/I18nProvider';
import { useOffline } from '@/app/providers/OfflineProvider';

/**
 * Connection banner.
 *
 * Offline, syncing, synced, failed — driven by the real queue, so "3 actions
 * waiting to sync" is a count of actions genuinely not yet accepted by the
 * server. It appears only when there is something to say.
 *
 * Whether this environment talks to AWS at all used to sit here too, on every
 * screen. That mattered enough to say once and not enough to say constantly, so
 * it now lives in Settings beside the rest of the shop's configuration — which
 * is where someone goes to ask the question. The point still stands: a local
 * write must never look identical to a cloud write.
 */
export function ConnectionBanner() {
  const t = useT();
  const { online, pendingCount, status, lastSyncedCount, syncNow } = useOffline();

  return (
    <div className="sticky top-0 z-30">
      <AnimatePresence initial={false} mode="popLayout">
        {!online ? (
          <Banner key="offline" tone="warning" icon={WifiOff}>
            <span className="font-semibold">{t('offline.offline')}</span>
            <span className="opacity-80">
              {pendingCount > 0
                ? pendingCount === 1
                  ? t('offline.pendingOne')
                  : t('offline.pendingMany', { count: pendingCount })
                : t('offline.offlineBody')}
            </span>
          </Banner>
        ) : status === 'syncing' ? (
          <Banner key="syncing" tone="info" icon={RefreshCw} spin>
            <span className="font-semibold">{t('offline.syncing')}</span>
          </Banner>
        ) : status === 'synced' ? (
          <Banner key="synced" tone="success" icon={Check}>
            <span className="font-semibold">
              {lastSyncedCount === 1
                ? t('offline.syncedOne')
                : t('offline.syncedMany', { count: lastSyncedCount })}
            </span>
          </Banner>
        ) : status === 'failed' ? (
          <Banner key="failed" tone="danger" icon={TriangleAlert}>
            <span className="font-semibold">{t('offline.syncFailed')}</span>
            <button
              type="button"
              onClick={() => void syncNow()}
              className="underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </Banner>
        ) : pendingCount > 0 ? (
          <Banner key="pending" tone="info" icon={CloudOff}>
            <span className="font-semibold">
              {pendingCount === 1
                ? t('offline.pendingOne')
                : t('offline.pendingMany', { count: pendingCount })}
            </span>
            <button
              type="button"
              onClick={() => void syncNow()}
              className="underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </Banner>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const TONES = {
  warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  info: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]',
  success: 'bg-[var(--color-success-soft)] text-[var(--color-success)]',
  danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
  neutral: 'bg-[var(--color-sunken)] text-[var(--color-muted)]',
} as const;

function Banner({
  tone,
  icon: Icon,
  spin,
  children,
}: {
  tone: keyof typeof TONES;
  icon: typeof WifiOff;
  spin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
      // Status, not alert: these should be announced without interrupting.
      role="status"
      aria-live="polite"
    >
      <div className={`flex items-center gap-2 px-4 py-2 text-xs ${TONES[tone]}`}>
        <Icon className={`size-4 shrink-0 ${spin ? 'animate-spin' : ''}`} aria-hidden="true" />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">{children}</div>
      </div>
    </motion.div>
  );
}
