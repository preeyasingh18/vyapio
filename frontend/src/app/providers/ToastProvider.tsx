import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Info, TriangleAlert, WifiOff, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Toasts.
 *
 * Deliberately restrained: a toast is for confirming something the user just
 * did. Anything that needs a decision belongs in a sheet, and anything that
 * persists belongs on the page. Errors are announced politely to screen readers
 * via an aria-live region rather than stealing focus.
 */

export type ToastTone = 'success' | 'error' | 'info' | 'offline';

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
};

type ToastContextValue = {
  toast: (input: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { icon: typeof Check; className: string }> = {
  success: { icon: Check, className: 'text-[var(--color-success)]' },
  error: { icon: TriangleAlert, className: 'text-[var(--color-danger)]' },
  info: { icon: Info, className: 'text-[var(--color-primary)]' },
  offline: { icon: WifiOff, className: 'text-[var(--color-warning)]' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setToasts((current) => [...current.slice(-2), { ...input, id }]);

      // Errors linger, because they usually need reading twice.
      const duration = input.tone === 'error' ? 6000 : 3500;
      window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: 'success', title, ...(description ? { description } : {}) }),
      error: (title, description) => toast({ tone: 'error', title, ...(description ? { description } : {}) }),
      info: (title, description) => toast({ tone: 'info', title, ...(description ? { description } : {}) }),
      dismiss,
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        // Sits above the bottom nav on mobile and bottom-right on desktop.
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] sm:bottom-6 sm:right-6 sm:left-auto sm:items-end sm:pb-0"
        role="region"
        aria-live="polite"
        aria-label="Notifications"
      >
        <AnimatePresence initial={false}>
          {toasts.map((entry) => {
            const { icon: Icon, className } = TONE_STYLES[entry.tone];
            return (
              <motion.div
                key={entry.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-elevated)] p-3.5 shadow-[var(--shadow-lift)]"
              >
                <Icon className={cn('mt-0.5 size-5 shrink-0', className)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--color-ink)]">{entry.title}</p>
                  {entry.description ? (
                    <p className="mt-0.5 text-sm leading-snug text-[var(--color-muted)]">
                      {entry.description}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(entry.id)}
                  className="-m-1 rounded-[var(--radius-control)] p-1 text-[var(--color-faint)] transition-colors hover:text-[var(--color-ink)]"
                  aria-label="Dismiss"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
