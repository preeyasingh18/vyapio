import { useState } from 'react';
import { cn } from '@/lib/cn';

export type BarPoint = { label: string; value: number; emphasis?: boolean };

/**
 * A short bar chart for a week of takings.
 *
 * Bars rather than a line because seven daily totals are discrete quantities,
 * not a continuous signal — a line between Tuesday and Wednesday implies
 * values that never existed. Kept under 80px tall: it is a glance, not a
 * report, and the report is one tap away.
 *
 * A day with no sales renders as a visible baseline stub rather than nothing,
 * so a closed Sunday reads as "zero" instead of as missing data.
 */
export function MiniBars({
  points,
  format,
  className,
  height = 72,
}: {
  points: BarPoint[];
  format: (value: number) => string;
  className?: string;
  height?: number;
}) {
  const [active, setActive] = useState<number | null>(null);

  if (points.length === 0) return null;

  const max = Math.max(...points.map((point) => point.value), 1);
  const shown = active === null ? null : points[active];

  return (
    <div className={cn('w-full', className)}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {points.map((point, index) => {
          const ratio = point.value / max;
          const isActive = active === index;

          return (
            <button
              key={`${point.label}-${index}`}
              type="button"
              className="group relative flex h-full flex-1 items-end rounded-t-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              aria-label={`${point.label}: ${format(point.value)}`}
            >
              <span
                className={cn(
                  'w-full rounded-[3px] transition-colors',
                  point.emphasis
                    ? 'bg-[var(--color-primary)]'
                    : isActive
                      ? 'bg-[var(--color-primary)]/70'
                      : 'bg-[var(--color-primary)]/25 group-hover:bg-[var(--color-primary)]/45',
                )}
                // 3px floor keeps a zero day visible as a baseline.
                style={{ height: `max(3px, ${Math.round(ratio * 100)}%)` }}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex gap-1.5">
        {points.map((point, index) => (
          <span
            key={`${point.label}-label-${index}`}
            className={cn(
              'flex-1 text-center text-[10px] font-medium transition-colors',
              point.emphasis || active === index
                ? 'text-[var(--color-ink)]'
                : 'text-[var(--color-faint)]',
            )}
          >
            {point.label}
          </span>
        ))}
      </div>

      {/* Read-out sits in fixed space so hovering does not reflow the panel. */}
      <p className="mt-2 h-4 text-xs text-[var(--color-muted)]">
        {shown ? (
          <>
            <span className="font-semibold text-[var(--color-ink)] tabular">
              {format(shown.value)}
            </span>
            {` · ${shown.label}`}
          </>
        ) : null}
      </p>
    </div>
  );
}
