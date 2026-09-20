import { useId, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Sparkline.
 *
 * Hand-drawn SVG rather than a charting library: the whole component is under a
 * hundred lines, inherits the theme's colours directly, and adds nothing to the
 * bundle on a screen a shopkeeper visits once a week.
 *
 * It is a real chart, not decoration — it has a baseline, an accessible table
 * fallback, and a hover read-out — but it stays deliberately quiet.
 */
export function Sparkline({
  values,
  labels,
  format,
  className,
  height = 96,
}: {
  values: number[];
  labels: string[];
  format: (value: number) => string;
  className?: string;
  height?: number;
}) {
  const gradientId = useId();
  const [active, setActive] = useState<number | null>(null);

  if (values.length === 0) return null;

  const max = Math.max(...values, 1);
  const width = 100;
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  // Top and bottom padding so the peak is never clipped and the baseline sits
  // above the axis labels.
  const pad = 8;
  const usable = 100 - pad * 2;

  const points = values.map((value, index) => ({
    x: index * step,
    y: pad + (1 - value / max) * usable,
    value,
    label: labels[index] ?? '',
  }));

  const line = points.map((point) => `${point.x},${point.y}`).join(' ');
  const area = `0,100 ${line} ${width},100`;

  const shown = active ?? values.length - 1;
  const current = points[shown];

  return (
    <div className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        style={{ height }}
        className="w-full"
        role="img"
        aria-label={`Sales over ${values.length} days. Highest ${format(max)}.`}
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <polygon points={area} fill={`url(#${gradientId})`} />

        <polyline
          points={line}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          // The viewBox is non-uniformly scaled, so the stroke must not be.
          vectorEffect="non-scaling-stroke"
        />

        {current ? (
          <circle
            cx={current.x}
            cy={current.y}
            r="2"
            fill="var(--color-primary)"
            stroke="var(--color-surface)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Invisible hit areas: one per point, full height so they are easy to
            hit with a finger as well as a cursor. */}
        {points.map((point, index) => (
          <rect
            key={index}
            x={point.x - step / 2}
            y="0"
            width={step || width}
            height="100"
            fill="transparent"
            onMouseEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
          />
        ))}
      </svg>

      {current ? (
        <p className="mt-2 text-center text-xs text-[var(--color-muted)]">
          <span className="font-semibold text-[var(--color-ink)] tabular">
            {format(current.value)}
          </span>
          {current.label ? ` · ${current.label}` : ''}
        </p>
      ) : null}

      {/* Accessible equivalent: a chart nobody can read is not a chart. */}
      <table className="sr-only">
        <caption>Sales by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Sales</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={index}>
              <td>{point.label}</td>
              <td>{format(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
