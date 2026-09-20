import { motion, useReducedMotion } from 'framer-motion';
import { BrainCircuit, Check, Mic, Store } from 'lucide-react';
import { LogoMark } from '@/components/brand/Logo';
import { cn } from '@/lib/cn';

/**
 * The hero visual: the shop itself.
 *
 * A miniature of a neighbourhood kirana — awning, crates of fruit, sacks of
 * rice, a bicycle — sitting in a lavender arch, with two moments from the
 * product floating over it.
 *
 * The artwork carries its lavender ground baked in, so it is multiplied into
 * the arch rather than laid on top of it. That is what stops the image reading
 * as a rectangle pasted onto a shape — see the note on the image itself.
 *
 * Why a shop and not a screenshot of the app: the person deciding whether to
 * try this is standing behind a counter, and the first thing the page should do
 * is recognise them. The interface can speak for itself once they are inside.
 */
export function ShopScene({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion();

  const float = (delay: number) =>
    reduceMotion
      ? {}
      : {
          animate: { y: [0, -9, 0] },
          transition: { duration: 5.5, repeat: Infinity, ease: 'easeInOut' as const, delay },
        };

  return (
    <div className={cn('relative', className)}>
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        /**
         * A plain rounded card.
         *
         * This was an arch, on the theory that a rounded top would follow the
         * shopfront. It cut the artwork's top corners off instead, and because
         * the curve and the image's own rectangle did not agree, the edge of
         * the picture showed through the blend. A rectangle holds the whole
         * shop and has no seam to hide.
         */
        className="relative aspect-[8/7] w-full overflow-hidden rounded-[var(--radius-card)] bg-[#EFEBF8]"
      >
        <span className="absolute top-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 text-[9px] font-semibold tracking-[0.16em] whitespace-nowrap text-[#9987ac] uppercase sm:top-7 sm:text-[10px]">
          <Store className="size-3" aria-hidden="true" />
          Your shop, with superpowers
        </span>

        <img
          src="/images/shop.webp"
          /**
           * `multiply` is what makes the shop sit *in* the arch.
           *
           * The artwork carries its own lavender ground, so dropping it in as
           * an opaque rectangle left its four corners showing against the arch
           * — two lavenders meeting at a hard edge. Multiplying blends that
           * ground into the arch behind it: identical values cancel out, the
           * shop and its shadow stay, and the rectangle disappears.
           *
           * The arch is set a shade lighter than the artwork's ground for the
           * same reason — multiply only ever darkens, so the arch has to start
           * above the value it needs to end at.
           *
           * `contain` keeps the whole shop in frame.
           *
           * Sizing it by width and letting it overflow cut the platform off the
           * bottom and the bicycle off the side — the artwork is a single
           * object, and a slice of it is not a smaller version of it. Contained,
           * it scales to whatever space it has and stays whole at every width.
           *
           * Anchored to the bottom with room reserved above, so the label at
           * the top of the arch has somewhere to sit that is not the roof.
           */
          className="absolute inset-0 size-full object-contain object-bottom pt-[12%] mix-blend-multiply"
          alt="A miniature neighbourhood grocery shop with a lavender awning, crates of fruit and a bicycle outside"
          width={1200}
          height={1026}
          fetchPriority="high"
          decoding="async"
        />

        {/* Inside the arch, where they read as part of the scene. */}
        <span
          className="absolute top-[18%] left-[12%] text-xl text-[var(--color-primary)]/40"
          aria-hidden="true"
        >
          ✳
        </span>
        <span
          className="absolute top-[26%] right-[12%] text-sm text-[var(--color-primary)]/35"
          aria-hidden="true"
        >
          ✦
        </span>

        {/* ── The promise, signed ───────────────────────────────────────── */}
        {/*
          Inside the arch, on the lavender.

          It used to hang off the outer wrapper at `-bottom-2 -left-2`, which
          put it below and to the left of the arch on the bare cream page —
          reading as something that had slipped out of the picture rather than
          as part of it. Set on the same ground as the shop, it is the scene's
          closing line.
        */}
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.65 }}
          className="absolute bottom-4 left-4 z-20 sm:bottom-5 sm:left-5"
        >
          {/* A card, like the two beside it: as bare text it sat straight on
              the artwork's shadow and could not be read. */}
          <span className="flex items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-surface)] py-2.5 pr-3.5 pl-2.5 shadow-[var(--shadow-lift)]">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-lavender)]">
              <LogoMark size={16} />
            </span>
            <span className="text-[11px] leading-tight text-[var(--color-muted)]">
              Less to remember.
              <br />
              <b className="font-bold text-[var(--color-ink)]">More room to grow.</b>
            </span>
          </span>
        </motion.div>
      </motion.div>

      {/* ── Every customer, remembered ──────────────────────────────────── */}
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, x: -18, y: 10 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={{ duration: 0.5, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="absolute top-[20%] -left-3 z-10 w-[60%] max-w-[260px] sm:-left-7 lg:-left-12"
      >
        <motion.div
          {...float(0)}
          className="flex items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-surface)] py-2.5 pr-3 pl-2.5 shadow-[var(--shadow-lift)]"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-lavender)] text-[var(--color-primary)]">
            <BrainCircuit className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] leading-tight font-bold text-[var(--color-ink)]">
              Every customer. Remembered.
            </span>
            <span className="block text-[10px] leading-tight text-[var(--color-muted)]">
              A familiar face. A familiar favourite.
            </span>
          </span>
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-success)] text-white">
            <Check className="size-2.5" aria-hidden="true" />
          </span>
        </motion.div>
      </motion.div>

      {/* ── Just say the word ───────────────────────────────────────────── */}
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, x: 18, y: 10 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={{ duration: 0.5, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="absolute -right-2 bottom-[13%] z-10 w-[56%] max-w-[240px] sm:-right-6 lg:-right-10"
      >
        <motion.div
          {...float(1.4)}
          className="flex items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-surface)] py-2.5 pr-3 pl-2.5 shadow-[var(--shadow-lift)]"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-peach)] text-[var(--color-accent)]">
            <Mic className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] leading-tight font-bold text-[var(--color-ink)]">
              Just say the word.
            </span>
            {/* A waveform, not a spectrum analyser: it says "listening". */}
            <span className="mt-1 flex items-end gap-[2px]" aria-hidden="true">
              {Array.from({ length: 15 }, (_, index) => (
                <i
                  key={index}
                  className="block w-[2px] rounded-full bg-[var(--color-primary)]/45"
                  style={{ height: `${6 + ((index * 7) % 15)}px` }}
                />
              ))}
            </span>
          </span>
          <span className="shrink-0 text-[9px] font-semibold text-[var(--color-muted)]">
            EN / हिन्दी
          </span>
        </motion.div>
      </motion.div>

    </div>
  );
}
