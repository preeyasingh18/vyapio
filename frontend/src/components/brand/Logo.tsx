import { cn } from '@/lib/cn';

/**
 * The mark on its own, without the wordmark.
 *
 * For the places that need the brand present but have no room for its name —
 * a sidebar row, a loading screen, the corner of a card. Sized in pixels rather
 * than by a scale so a caller can match whatever it sits beside.
 *
 * `pulse` animates the bars in sequence. It is for moments the app is doing
 * something and the person is waiting; state is always also carried by the text
 * beside it, so the motion is decoration on top of information that is already
 * there and reduced-motion loses nothing.
 */
export function LogoMark({
  size = 28,
  tone = 'primary',
  pulse = false,
  label,
  className,
}: {
  size?: number;
  tone?: 'primary' | 'light' | 'current';
  pulse?: boolean;
  /**
   * Announces what the mark is standing in for, when it stands alone.
   *
   * Decoration by default — beside a heading or a line of status text it would
   * only repeat what is already being read out. But on a screen where the mark
   * is the *only* thing, silence is the whole message, so those callers pass a
   * label and it becomes an image with a name.
   */
  label?: string;
  className?: string;
}) {
  const colour =
    tone === 'light' ? 'bg-white/85' : tone === 'current' ? 'bg-current' : 'bg-[var(--color-primary)]';

  // Same proportions as the wordmark's symbol: bars a seventh of the width,
  // gaps half a bar, heights stepping 55% / 77% / 100%.
  const bar = size * 0.18;
  const gap = size * 0.09;

  return (
    <span
      className={cn('inline-flex shrink-0 items-center -rotate-[9deg]', className)}
      style={{ gap, width: size, height: size }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {[0.55, 0.77, 1].map((scale, index) => (
        <i
          key={scale}
          className={cn('block rounded-full', colour, pulse && 'logo-bar-pulse')}
          style={{
            width: bar,
            height: size * 0.82 * scale,
            animationDelay: pulse ? `${index * 0.16}s` : undefined,
          }}
        />
      ))}
    </span>
  );
}

/**
 * The Vyapio wordmark.
 *
 * Three bars of unequal height, tilted slightly, then the name in the display
 * face with a coloured full stop. The bars read as a small rising chart — a
 * shop growing — and the tilt keeps them from looking like a signal-strength
 * icon, which is what an upright version of the same three bars becomes.
 *
 * Rendered as text and shapes rather than as an image so it stays sharp at
 * every size, follows the theme, and costs no request.
 */
export function Logo({
  size = 'md',
  tone = 'ink',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  /** `light` for dark grounds — the sidebar, the footer, the dark section. */
  tone?: 'ink' | 'light';
  className?: string;
}) {
  const bar = {
    sm: { w: 'w-[4px]', gap: 'gap-[2px]', heights: ['h-[9px]', 'h-[13px]', 'h-[17px]'], mr: 'mr-1.5' },
    md: { w: 'w-[5px]', gap: 'gap-[2.5px]', heights: ['h-[12px]', 'h-[17px]', 'h-[22px]'], mr: 'mr-2' },
    lg: { w: 'w-[6px]', gap: 'gap-[3px]', heights: ['h-[15px]', 'h-[21px]', 'h-[27px]'], mr: 'mr-2' },
  }[size];

  const text = { sm: 'text-[17px]', md: 'text-[22px]', lg: 'text-[31px]' }[size];

  return (
    <span
      className={cn(
        'inline-flex items-center font-display leading-none font-bold tracking-[-0.055em]',
        text,
        tone === 'light' ? 'text-white' : 'text-[var(--color-ink)]',
        className,
      )}
    >
      <span
        className={cn('flex items-center -rotate-[9deg]', bar.gap, bar.mr)}
        aria-hidden="true"
      >
        {bar.heights.map((height) => (
          <i
            key={height}
            className={cn(
              'block rounded-full',
              bar.w,
              height,
              tone === 'light' ? 'bg-white/85' : 'bg-[var(--color-primary)]',
            )}
          />
        ))}
      </span>
      vyapio
      <span className={tone === 'light' ? 'text-white/55' : 'text-[var(--color-primary)]'}>.</span>
    </span>
  );
}
