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
         * An arch, not a rectangle — the shape the design is drawn around.
         *
         * The curve has to clear the shopfront rather than crop it, so the
         * radius is shallow and the artwork is inset below it. An arch tight
         * enough to look like an arch is also tight enough to take the corners
         * off the roof.
         */
        className="relative aspect-[8/7] w-full overflow-hidden rounded-t-[46%] rounded-b-[34px] bg-[#EAE4F7]"
      >
        <span className="absolute top-7 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 text-[9px] font-semibold tracking-[0.16em] whitespace-nowrap text-[#9987ac] uppercase sm:top-7 sm:text-[10px]">
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
          className="absolute inset-0 size-full object-contain object-bottom px-[5%] pt-[11%] pb-[2%] mix-blend-multiply"
          alt="A miniature neighbourhood grocery shop with a lavender awning, crates of fruit and a bicycle outside"
          width={1200}
          height={1026}
          fetchPriority="high"
          decoding="async"
        />


        {/* ── The promise, signed ───────────────────────────────────────── */}
        {/*
          The third card, and the scene's closing line.

          Set as bare text on the lavender it could not be read — grey on a
          tinted ground, over the artwork's own shadow. On white, like the two
          beside it, it carries.
        */}
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.65 }}
          className="absolute bottom-4 left-2 z-20 sm:bottom-6 sm:left-4"
        >
          <motion.div
            {...float(2.6)}
            className="flex -rotate-[3deg] items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-surface)] py-2.5 pr-3.5 pl-2.5 shadow-[var(--shadow-lift)]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-lavender)]">
              <LogoMark size={15} />
            </span>
            <span className="min-w-0 text-[11px] leading-tight text-[var(--color-muted)]">
              Less to remember.
              <br />
              <b className="font-bold text-[var(--color-ink)]">More room to grow.</b>
            </span>
          </motion.div>
        </motion.div>
      </motion.div>

      {/*
        Two marks on the page, outside the arch.

        Drawn rather than typed: as the characters ✳ and ✦ they fell back to
        whatever font the machine happened to have, so their weight and even
        their number of points changed from screen to screen.
      */}
      <motion.svg
        viewBox="0 0 24 24"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.75 }}
        className="absolute top-[14%] -left-1 z-0 size-7 text-[var(--color-primary)] sm:-left-4 sm:size-9"
        aria-hidden="true"
      >
        <path
          d="M12 1.5v21M2.6 6.75l18.8 10.5M21.4 6.75L2.6 17.25"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </motion.svg>

      <motion.svg
        viewBox="0 0 24 24"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.85 }}
        className="absolute top-[22%] -right-1 z-0 size-5 text-[#E0A63C] sm:-right-3 sm:size-6"
        aria-hidden="true"
      >
        {/* A four-point star: two slender lobes crossing, not a polygon. */}
        <path
          d="M12 1.2c.9 6 3.9 9 9.9 10.8-6 1.8-9 4.8-9.9 10.8-.9-6-3.9-9-9.9-10.8 6-1.8 9-4.8 9.9-10.8Z"
          fill="currentColor"
        />
      </motion.svg>

      {/* ── Every customer, remembered ──────────────────────────────────── */}
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, x: -18, y: 10 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={{ duration: 0.5, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="absolute top-[24%] -left-2 z-10 w-[62%] max-w-[300px] sm:-left-6 lg:-left-10"
      >
        {/* Tilted, so the cards read as laid over the scene rather than
            pinned to the page grid. */}
        <motion.div
          {...float(0)}
          className="flex -rotate-[4deg] items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-surface)] py-2.5 pr-3 pl-2.5 shadow-[var(--shadow-lift)]"
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
        className="absolute -right-2 bottom-[18%] z-10 w-[58%] max-w-[280px] sm:-right-5 lg:-right-8"
      >
        <motion.div
          {...float(1.4)}
          className="flex rotate-[4deg] items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-surface)] py-2.5 pr-3 pl-2.5 shadow-[var(--shadow-lift)]"
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
