import { forwardRef, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowRight, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Data-display primitives.
 *
 * The rule this file exists to enforce: **a card is not the default**. Most
 * information in Vyapio is a list of comparable things — customers, sales,
 * balances, stock — and lists read faster than a grid of bordered boxes. So
 * the containers here are deliberately plain (`Panel`, `Rows`) and the rows
 * inside them carry no chrome of their own beyond a hairline divider.
 *
 * Everything is built from the same four parts — eyebrow, title, support,
 * action — so a shopkeeper learns one row and can read every screen.
 */

/* ----------------------------------------------------------------- Panel */

/**
 * A plain surface. One border, one small radius, no shadow by default.
 *
 * Use this instead of `Card` wherever the surface is grouping content rather
 * than floating above it, which is almost always.
 */
export function Panel({
  className,
  inset,
  ...props
}: HTMLAttributes<HTMLDivElement> & { inset?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]',
        inset && 'p-4 sm:p-5',
        className,
      )}
      {...props}
    />
  );
}

/* --------------------------------------------------------- SectionHeader */

/**
 * The only heading pattern in the app.
 *
 * Small, uppercase, tracked — a label, not a title. Pages already have one
 * real heading; every band below it is a signpost and should not compete.
 */
export function SectionHeader({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[length:var(--text-eyebrow)] font-bold tracking-[0.1em] text-[var(--color-muted)] uppercase">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-sm text-[var(--color-muted)]">{hint}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A quiet "View all →" that pairs with SectionHeader. */
export function SeeAll({ to, label = 'View all' }: { to: string; label?: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-primary)] transition-colors hover:text-[var(--color-primary-hover)]"
    >
      {label}
      <ArrowRight
        className="size-3.5 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}

/* ---------------------------------------------------------------- Metric */

const metricValue = cva('font-extrabold tracking-tight tabular text-[var(--color-ink)]', {
  variants: {
    size: {
      /** Inline figure inside a row. */
      sm: 'text-base',
      /** Supporting figure in a group. */
      md: 'text-xl',
      /** The one number a page is about. */
      lg: 'text-[length:var(--text-metric)] leading-none',
      xl: 'text-[length:var(--text-metric-lg)] leading-none',
    },
    tone: {
      default: '',
      success: 'text-[var(--color-success)]',
      warning: 'text-[var(--color-warning)]',
      danger: 'text-[var(--color-danger)]',
    },
  },
  defaultVariants: { size: 'md', tone: 'default' },
});

/**
 * A labelled figure.
 *
 * Deliberately *not* a card: metrics sit together in a row separated by
 * dividers, so they read as one summary rather than as competing tiles.
 */
export function Metric({
  label,
  value,
  size,
  tone,
  delta,
  support,
  className,
}: VariantProps<typeof metricValue> & {
  label: string;
  value: ReactNode;
  /** Signed change, already formatted, e.g. "↑ 12.4%". */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' };
  support?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="truncate text-[length:var(--text-eyebrow)] font-semibold tracking-[0.08em] text-[var(--color-muted)] uppercase">
        {label}
      </p>
      <p className={cn('mt-1.5', metricValue({ size, tone }))}>{value}</p>
      {delta ? (
        <p
          className={cn(
            'mt-1 text-xs font-semibold tabular',
            delta.direction === 'up'
              ? 'text-[var(--color-success)]'
              : delta.direction === 'down'
                ? 'text-[var(--color-danger)]'
                : 'text-[var(--color-muted)]',
          )}
        >
          {delta.text}
        </p>
      ) : null}
      {support ? <p className="mt-1 text-xs text-[var(--color-muted)]">{support}</p> : null}
    </div>
  );
}

/** Metrics side by side, divided rather than boxed. */
export function MetricRow({
  children,
  className,
  columns = 3,
}: {
  children: ReactNode;
  className?: string;
  columns?: 2 | 3 | 4;
}) {
  return (
    <div
      className={cn(
        'grid divide-x divide-[var(--color-line)]',
        columns === 2 && 'grid-cols-2',
        columns === 3 && 'grid-cols-3',
        columns === 4 && 'grid-cols-2 sm:grid-cols-4',
        '[&>*]:px-4 [&>*:first-child]:pl-0 [&>*:last-child]:pr-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ----------------------------------------------------------- StatusBadge */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

const STATUS_TONE: Record<StatusTone, string> = {
  neutral: 'bg-[var(--color-sunken)] text-[var(--color-ink-soft)]',
  info: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]',
  success: 'bg-[var(--color-success-soft)] text-[var(--color-success)]',
  warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
  accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
};

const DOT_TONE: Record<StatusTone, string> = {
  neutral: 'bg-[var(--color-faint)]',
  info: 'bg-[var(--color-primary)]',
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
  accent: 'bg-[var(--color-accent)]',
};

/**
 * A status chip.
 *
 * Carries a dot as well as colour, because roughly one man in twelve cannot
 * separate the red from the green — and "paid" versus "overdue" is exactly
 * the distinction that must never rest on hue alone.
 */
export function StatusBadge({
  tone = 'neutral',
  children,
  dot = true,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        STATUS_TONE[tone],
        className,
      )}
    >
      {dot ? <span className={cn('size-1.5 rounded-full', DOT_TONE[tone])} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Rows */

/**
 * A divided list.
 *
 * The dividers do the grouping, so individual rows need no border, no radius
 * and no shadow — which is what keeps a screen of twenty customers from
 * looking like twenty cards.
 */
export function Rows({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('divide-y divide-[var(--color-line)]', className)}
      {...props}
    />
  );
}

/**
 * One line of a list.
 *
 * `to` renders it as a link with the whole row as the hit target — on a phone
 * behind a counter, a small chevron is not a usable tap area.
 */
export function Row({
  to,
  onClick,
  leading,
  title,
  subtitle,
  trailing,
  meta,
  className,
  compact,
}: {
  to?: string;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned block: a figure, a badge, or both stacked. */
  trailing?: ReactNode;
  /** Small text under the trailing block. */
  meta?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const interactive = Boolean(to || onClick);

  const body = (
    <>
      {leading ? <span className="shrink-0">{leading}</span> : null}

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">
          {title}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-xs text-[var(--color-muted)]">{subtitle}</span>
        ) : null}
      </span>

      {trailing || meta ? (
        <span className="shrink-0 text-right">
          {trailing ? <span className="block">{trailing}</span> : null}
          {meta ? (
            <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{meta}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  const classes = cn(
    'flex w-full items-center gap-3 text-left',
    compact ? 'py-2.5' : 'py-3',
    interactive &&
      'transition-colors hover:bg-[var(--color-sunken)] -mx-3 px-3 rounded-[var(--radius-control)]',
    className,
  );

  if (to) {
    return (
      <Link to={to} className={classes}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

/* ----------------------------------------------------------- AttentionRow */

/**
 * A row that asks for a decision.
 *
 * Used on the dashboard's "Needs your attention" band. The accent stripe on
 * the leading edge encodes severity without colouring the whole row, so three
 * of these stacked still read as a list rather than as three warning cards.
 */
export function AttentionRow({
  tone = 'neutral',
  icon,
  title,
  detail,
  action,
  className,
}: {
  tone?: StatusTone;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-3 py-3.5', className)}>
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)]',
          STATUS_TONE[tone],
        )}
        aria-hidden="true"
      >
        {icon}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--color-ink)]">{title}</p>
        {detail ? (
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-muted)]">{detail}</p>
        ) : null}
      </div>

      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------- ActivityItem */

/**
 * A timeline entry.
 *
 * The connecting line is drawn by the container so it never breaks between
 * items; `last` stops it running past the final dot.
 */
export function ActivityItem({
  title,
  detail,
  time,
  tone = 'neutral',
  last,
}: {
  title: ReactNode;
  detail?: ReactNode;
  time: string;
  tone?: StatusTone;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last ? (
        <span
          className="absolute top-4 bottom-0 left-[5px] w-px bg-[var(--color-line)]"
          aria-hidden="true"
        />
      ) : null}

      <span
        className={cn('relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-[var(--color-surface)]', DOT_TONE[tone])}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{title}</p>
          <time className="shrink-0 text-xs text-[var(--color-faint)]">{time}</time>
        </div>
        {detail ? (
          <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">{detail}</p>
        ) : null}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------- QuickAction */

/**
 * A compact action button with an icon.
 *
 * Explicitly not a marketing tile: one line of text, a fixed height, and it
 * sits in a row with its siblings. `emphasis="primary"` marks the single
 * action that starts the shop's main loop.
 */
export function QuickAction({
  to,
  onClick,
  icon,
  label,
  emphasis = 'default',
  badge,
  className,
}: {
  to?: string;
  onClick?: () => void;
  icon: ReactNode;
  label: string;
  emphasis?: 'primary' | 'default';
  badge?: ReactNode;
  className?: string;
}) {
  const classes = cn(
    'group relative flex h-11 items-center gap-2.5 rounded-[var(--radius-field)] px-3.5 text-sm font-semibold',
    'transition-[background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.98]',
    emphasis === 'primary'
      ? 'bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--shadow-hair)] hover:brightness-[1.04]'
      : 'border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-sunken)]',
    className,
  );

  const body = (
    <>
      <span
        className={cn(
          'shrink-0',
          emphasis === 'primary' ? '' : 'text-[var(--color-primary)]',
        )}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {badge ? <span className="ml-auto shrink-0">{badge}</span> : null}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={classes}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {body}
    </button>
  );
}

/* ------------------------------------------------------------- SearchBar */

export const SearchBar = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'type'> & {
    onClear?: () => void;
  }
>(function SearchBar({ className, value, onClear, ...props }, ref) {
  return (
    <div className={cn('relative flex items-center', className)}>
      <Search
        className="pointer-events-none absolute left-3 size-4 text-[var(--color-faint)]"
        aria-hidden="true"
      />
      <input
        ref={ref}
        type="search"
        value={value}
        className={cn(
          'h-10 w-full rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface)] pr-9 pl-9',
          // 16px on mobile stops iOS zooming the viewport on focus.
          'text-base sm:text-sm',
          'text-[var(--color-ink)] placeholder:text-[var(--color-faint)]',
          'transition-colors focus:border-[var(--color-primary)] focus:outline-none',
          // The UA's own clear button would sit beside ours.
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
        {...props}
      />
      {value && onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 rounded-[var(--radius-control)] p-1 text-[var(--color-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          aria-label="Clear search"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------ IconButton */

export const IconButton = forwardRef<
  HTMLButtonElement,
  HTMLAttributes<HTMLButtonElement> & {
    label: string;
    icon: ReactNode;
    tone?: 'default' | 'danger';
    size?: 'sm' | 'md';
    disabled?: boolean;
    type?: 'button' | 'submit';
  }
>(function IconButton({ label, icon, tone = 'default', size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-control)] transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]',
        size === 'sm' ? 'size-8' : 'size-9',
        tone === 'danger'
          ? 'text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]'
          : 'text-[var(--color-muted)] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]',
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});

/* ----------------------------------------------------------------- Table */

/**
 * A table on wide screens, a list of rows on narrow ones.
 *
 * Both render from the same data. A real `<table>` is kept for the desktop
 * case because column alignment is what makes a financial list scannable, and
 * it is what screen readers announce correctly.
 */
export function Table<T>({
  rows,
  columns,
  getKey,
  getHref,
  rowLabel,
  renderCard,
  empty,
  className,
}: {
  rows: T[];
  columns: Array<{
    key: string;
    header: string;
    /** Right-align figures; left-align everything else. */
    align?: 'left' | 'right';
    /** Hide on medium screens when the column is supporting detail. */
    hideBelow?: 'lg' | 'xl';
    cell: (row: T) => ReactNode;
    width?: string;
  }>;
  getKey: (row: T) => string;
  getHref?: (row: T) => string;
  /**
   * What the row's link is called, for a screen reader.
   *
   * The link covers the row but contains no text of its own, so without this
   * it would be announced as an unnamed link. Falls back to the first column's
   * content where that is already a plain name.
   */
  rowLabel?: (row: T) => string;
  /** Narrow-screen rendering. Falls back to the first two columns. */
  renderCard?: (row: T) => ReactNode;
  empty?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className={className}>
      {/* ── Desktop ─────────────────────────────────────────────────────── */}
      <table className="hidden w-full border-collapse md:table">
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'pb-2 text-[length:var(--text-eyebrow)] font-semibold tracking-[0.08em] text-[var(--color-muted)] uppercase',
                  column.align === 'right' ? 'text-right' : 'text-left',
                  column.hideBelow === 'lg' && 'hidden lg:table-cell',
                  column.hideBelow === 'xl' && 'hidden xl:table-cell',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = getHref?.(row);

            return (
            <tr
              key={getKey(row)}
              className={cn(
                'group border-b border-[var(--color-line)] last:border-0 transition-colors hover:bg-[var(--color-sunken)]',
                href && 'cursor-pointer',
              )}
            >
              {columns.map((column, columnIndex) => (
                <td
                  key={column.key}
                  className={cn(
                    'py-3 align-middle text-sm',
                    // The stretched link below is positioned against this cell.
                    href && columnIndex === 0 && 'relative',
                    column.align === 'right' ? 'text-right' : 'text-left',
                    column.hideBelow === 'lg' && 'hidden lg:table-cell',
                    column.hideBelow === 'xl' && 'hidden xl:table-cell',
                  )}
                >
                  {/*
                    One real link per row, stretched over the whole row.

                    `getHref` used to reach only the narrow-screen cards, so on
                    a desktop the rows looked clickable — they even highlighted
                    on hover — and did nothing. Rather than a click handler on
                    the `<tr>`, which no keyboard or screen reader can use and
                    which cannot be opened in a new tab, this is an ordinary
                    anchor that happens to cover the row.

                    Anything interactive inside a cell must sit above it; see
                    the `relative z-10` on the action buttons in the stock table.
                  */}
                  {href && columnIndex === 0 ? (
                    <Link
                      to={href}
                      className="absolute inset-0 rounded-[var(--radius-control)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                      aria-label={rowLabel?.(row)}
                    />
                  ) : null}
                  {column.cell(row)}
                </td>
              ))}
            </tr>
            );
          })}
        </tbody>
      </table>

      {/* ── Narrow ──────────────────────────────────────────────────────── */}
      <div className="divide-y divide-[var(--color-line)] md:hidden">
        {rows.map((row) => {
          const content = renderCard ? (
            renderCard(row)
          ) : (
            <div className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">{columns[0]?.cell(row)}</div>
              <div className="shrink-0 text-right">{columns[1]?.cell(row)}</div>
            </div>
          );

          const href = getHref?.(row);
          return href ? (
            <Link
              key={getKey(row)}
              to={href}
              className="-mx-3 block rounded-[var(--radius-control)] px-3 transition-colors active:bg-[var(--color-sunken)]"
            >
              {content}
            </Link>
          ) : (
            <div key={getKey(row)}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}
