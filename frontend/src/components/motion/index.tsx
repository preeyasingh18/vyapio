import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion, type Transition } from 'framer-motion';
import { cn } from '@/lib/cn';

/**
 * Motion primitives.
 *
 * Every component here checks `useReducedMotion` and degrades to a static
 * render. That is possible because none of this motion carries information —
 * it is timing and emphasis on top of content that is already complete.
 */

const SPRING: Transition = { type: 'spring', stiffness: 320, damping: 32 };

/** Page transition. Deliberately subtle: a shopkeeper navigates constantly. */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Fades a block in, optionally after a delay, when it enters the viewport. */
export function FadeIn({
  children,
  delay = 0,
  y = 12,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Staggers direct children. Pair with `StaggerItem`. */
export function Stagger({
  children,
  className,
  delay = 0,
  step = 0.05,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  step?: number;
}) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: step, delayChildren: delay } } }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0, transition: SPRING },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/**
 * Animated number.
 *
 * Counting up makes a figure feel freshly computed rather than cached, which is
 * exactly the impression the home screen wants. With reduced motion the final
 * value is rendered immediately.
 */
export function Counter({
  value,
  format,
  className,
  duration = 900,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
  duration?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [display, setDisplay] = useState(reduceMotion ? value : 0);
  const frame = useRef<number>(0);
  const from = useRef(0);

  useEffect(() => {
    if (reduceMotion) {
      setDisplay(value);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    const delta = value - origin;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // easeOutExpo: fast start, long settle — reads as "landing" on a figure.
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplay(origin + delta * eased);

      if (progress < 1) frame.current = requestAnimationFrame(tick);
      else from.current = value;
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, duration, reduceMotion]);

  return (
    <span className={cn('tabular', className)}>{format(Math.round(display))}</span>
  );
}

/**
 * Microphone waveform.
 *
 * Bars are driven by real analyser data when it is supplied, so the shopkeeper
 * can see the app is genuinely hearing them. Without data it falls back to an
 * idle shimmer rather than faking a signal.
 */
export function Waveform({
  levels,
  active,
  bars = 28,
  className,
}: {
  /** 0..1 amplitudes from an AnalyserNode. */
  levels?: number[];
  active: boolean;
  bars?: number;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div
      className={cn('flex h-16 items-center justify-center gap-[3px]', className)}
      aria-hidden="true"
    >
      {Array.from({ length: bars }).map((_, index) => {
        const level = levels?.[index % (levels.length || 1)] ?? 0;
        // A gentle centre bias so the shape reads as a voice, not a bar chart.
        const centreBias = 1 - Math.abs(index - bars / 2) / (bars / 1.6);
        const height = active
          ? Math.max(4, level * 56 * Math.max(0.35, centreBias))
          : 4;

        return (
          <motion.span
            key={index}
            className="w-[3px] rounded-full bg-[var(--color-accent)]"
            animate={reduceMotion ? { height: active ? 18 : 4 } : { height }}
            transition={{ duration: 0.08, ease: 'easeOut' }}
            style={{ opacity: active ? 0.55 + Math.min(0.45, level) : 0.3 }}
          />
        );
      })}
    </div>
  );
}

/** Expand/collapse that animates height without measuring in the consumer. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return open ? <div>{children}</div> : null;

  return (
    <motion.div
      initial={false}
      animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      {children}
    </motion.div>
  );
}
