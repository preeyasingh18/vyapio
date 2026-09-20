import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MoreMenu } from '@/components/layout/MoreMenu';

/**
 * Page header.
 *
 * One line of identity, one line of context, and the page's single primary
 * action. `stats` renders inline rather than as cards below, because "36
 * customers · ₹17.2k outstanding" is a subtitle, not a dashboard.
 *
 * `back` is a real navigation affordance rather than decoration: on a phone
 * inside a PWA there is no browser chrome, so a screen pushed on top of
 * another must provide its own way out.
 */
export function PageHeader({
  title,
  subtitle,
  stats,
  back,
  actions,
  className,
  sticky = true,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Short figures shown beside the title, separated by dividers. */
  stats?: Array<{ label: string; value: ReactNode; tone?: 'default' | 'warning' | 'danger' }>;
  back?: boolean | string;
  actions?: ReactNode;
  className?: string;
  sticky?: boolean;
}) {
  const navigate = useNavigate();

  const goBack = () => {
    if (typeof back === 'string') navigate(back);
    else navigate(-1);
  };

  return (
    <header
      className={cn(
        'border-b border-[var(--color-line)] bg-[var(--color-surface)]',
        sticky && 'sticky top-0 z-20',
        className,
      )}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3.5 sm:px-6">
        {back ? (
          <button
            type="button"
            onClick={goBack}
            className="-ml-2 rounded-[var(--radius-control)] p-2 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-sunken)]"
            aria-label="Go back"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
        ) : null}

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold tracking-tight text-[var(--color-ink)] sm:text-xl">
            {title}
          </h1>

          {stats && stats.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              {stats.map((stat, index) => (
                <span key={stat.label} className="flex items-center gap-2">
                  {index > 0 ? (
                    <span className="text-[var(--color-line-strong)]" aria-hidden="true">
                      ·
                    </span>
                  ) : null}
                  <span>
                    <span
                      className={cn(
                        'font-semibold tabular',
                        stat.tone === 'warning'
                          ? 'text-[var(--color-warning)]'
                          : stat.tone === 'danger'
                            ? 'text-[var(--color-danger)]'
                            : 'text-[var(--color-ink)]',
                      )}
                    >
                      {stat.value}
                    </span>{' '}
                    <span className="text-[var(--color-muted)]">{stat.label}</span>
                  </span>
                </span>
              ))}
            </div>
          ) : subtitle ? (
            <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">{subtitle}</p>
          ) : null}
        </div>

        {/*
          The page's own action, then the way out to everything else.

          `MoreMenu` hides itself above the large breakpoint, where the sidebar
          already lists these. On a phone it is the only route to Orders,
          Reports, Payments and Settings, so it belongs on every screen rather
          than on the one that happened to have room for it.
        */}
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <MoreMenu />
        </div>
      </div>
    </header>
  );
}

/** Standard page body width and gutters. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-6', className)}>
      {children}
    </div>
  );
}

/**
 * Kept for screens that still import it.
 *
 * New code should use `SectionHeader` from the UI package — this is the same
 * pattern, but it lives beside the other primitives.
 */
export function SectionHeading({
  title,
  action,
  className,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex items-end justify-between gap-4', className)}>
      <h2 className="text-[length:var(--text-eyebrow)] font-bold tracking-[0.1em] text-[var(--color-muted)] uppercase">
        {title}
      </h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
