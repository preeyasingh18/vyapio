import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Boxes,
  Brain,
  Globe,
  Mic,
  ScanLine,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { useT } from '@/app/providers/I18nProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { Button } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { FadeIn, PageTransition } from '@/components/motion';
import { ShopScene } from './ShopScene';
import { Logo } from '@/components/brand/Logo';
import { HowItWorks } from './HowItWorks';
import { appConfig } from '@/app/config';
import { cn } from '@/lib/cn';

/**
 * Landing page.
 *
 * Written to make one argument: a shopkeeper's memory is the system of record,
 * and it fails. Each section states a job the shop already does in someone's
 * head and shows Vyapio doing it instead.
 *
 * The visual job is to look like a product that exists. So the hero shows the
 * real interface rather than an illustration, and the page alternates warm
 * paper against one near-black section so it has rhythm instead of being an
 * unbroken field of cards.
 */
export default function LandingPage() {
  const t = useT();
  const navigate = useNavigate();
  const { demoLogin } = useAuth();
  const toast = useToast();
  const { resolved, toggle } = useTheme();
  const reduceMotion = useReducedMotion();
  const [loadingDemo, setLoadingDemo] = useState(false);

  const openDemo = async () => {
    setLoadingDemo(true);
    try {
      await demoLogin();
      navigate('/app');
    } catch {
      toast.error('Could not open the demo shop', 'Check that the API is running, then try again.');
    } finally {
      setLoadingDemo(false);
    }
  };

  return (
    <PageTransition className="min-h-dvh bg-[var(--color-bg)]">
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="glass sticky top-0 z-40 border-b border-[var(--color-line)]/70">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo size="md" />

          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={toggle}
              className="rounded-[var(--radius-control)] p-2 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
              aria-label={t('a11y.toggleTheme')}
            >
              {resolved === 'dark' ? <SunGlyph /> : <MoonGlyph />}
            </button>
            <Button to="/login" variant="ghost" size="sm">
              {t('auth.signIn')}
            </Button>
            <Button to="/signup" size="sm">
              {t('landing.ctaPrimary')}
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* Drifting mesh, behind everything. */}
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <div className={cn('mesh absolute inset-0', !reduceMotion && 'drift')} />
          <div
            className={cn('mesh-dense absolute -top-1/4 right-0 h-[120%] w-3/4 opacity-40', !reduceMotion && 'drift-slow')}
          />
        </div>

        <div className="mx-auto grid max-w-6xl items-center gap-16 px-4 pt-10 pb-24 sm:px-6 sm:pt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pt-20 lg:pb-32">
          <div>
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
            >
              <p className="text-[11px] font-bold tracking-[0.22em] text-[var(--color-accent)] uppercase">
                {t('landing.eyebrow')}
              </p>

              {/*
                Three short lines, the last one carrying the weight.
                "A little shop." is the reader; "A lot to remember." is their
                problem. The underline sits under the word the whole product is
                about, drawn rather than styled so it keeps its hand-made kink.
              */}
              <h1 className="mt-4 font-display text-[3rem] leading-[1.02] font-bold tracking-[-0.035em] text-[var(--color-ink)] sm:text-[4.25rem] lg:text-[5rem]">
                A little shop.
                <br />
                A lot to
                <br />
                <span className="relative inline-block text-[var(--color-primary)]">
                  remember.
                  <svg
                    viewBox="0 0 470 20"
                    className="absolute -bottom-1 left-0 w-full"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M3 13 Q230 -2 466 10" opacity="0.45" />
                  </svg>
                </span>
              </h1>

              <p className="mt-5 max-w-md text-lg leading-relaxed text-[var(--color-muted)]">
                {t('landing.heroSubtitle')}
              </p>

              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Button
                  to="/signup"
                  size="lg"
                  icon={<ArrowRight className="size-4" />}
                  className="h-14 px-7 text-base shadow-[var(--shadow-lift)]"
                >
                  {t('landing.ctaPrimary')}
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-14 px-7 text-base"
                  onClick={() =>
                    document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })
                  }
                >
                  {t('landing.ctaSecondary')}
                </Button>
              </div>

              {appConfig.demoMode ? (
                <button
                  type="button"
                  onClick={() => void openDemo()}
                  disabled={loadingDemo}
                  className="group mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-primary)] disabled:opacity-60"
                >
                  {loadingDemo ? 'Opening…' : t('landing.ctaDemo')}
                  <ArrowRight
                    className="size-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </button>
              ) : null}

              <p className="mt-7 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-muted)]">
                <ShieldCheck className="size-3.5 text-[var(--color-success)]" aria-hidden="true" />
                <span>{t('landing.trustPrivate')}</span>
                <span className="text-[var(--color-faint)]">·</span>
                <span>{t('landing.trustNoSetup')}</span>
              </p>
            </motion.div>
          </div>

          <ShopScene className="lg:mt-2" />
        </div>
      </section>

      {/* ── The argument ────────────────────────────────────────────────── */}
      <section id="how" className="relative border-t border-[var(--color-line)] py-20 sm:py-28">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <FadeIn>
            <p className="text-[11px] font-bold tracking-[0.22em] text-[var(--color-accent)] uppercase">
              {t('landing.problemEyebrow')}
            </p>
            <h2 className="mt-4 max-w-3xl font-[family-name:var(--font-display)] text-4xl leading-[1.05] font-normal text-[var(--color-ink)] sm:text-6xl">
              {t('landing.sectionRemember')}
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--color-muted)]">
              {t('landing.sectionRememberBody')}
            </p>
          </FadeIn>

          {/* The chain. Stated before the capability grid, because the
              capabilities only mean anything once the chain is clear. */}
          <div className="mt-14">
            <p className="text-[11px] font-bold tracking-[0.22em] text-[var(--color-muted)] uppercase">
              {t('landing.howEyebrow')}
            </p>
            <HowItWorks className="mt-5" />
          </div>

          <div className="mt-16">
            <p className="text-[11px] font-bold tracking-[0.22em] text-[var(--color-muted)] uppercase">
              {t('landing.capabilitiesEyebrow')}
            </p>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={ScanLine} tone="accent" title={t('landing.sectionScan')} body={t('landing.sectionScanBody')} delay={0} />
            <Feature icon={Mic} tone="primary" title={t('landing.sectionSpeak')} body={t('landing.sectionSpeakBody')} delay={0.06} />
            <Feature icon={Boxes} tone="gold" title={t('landing.sectionThink')} body={t('landing.sectionThinkBody')} delay={0.12} />
            <Feature icon={Brain} tone="primary" title={t('landing.sectionMemory')} body={t('landing.sectionMemoryBody')} delay={0.18} />
            <Feature icon={Sparkles} tone="accent" title={t('landing.sectionAsk')} body={t('landing.sectionAskBody')} delay={0.24} />
            <Feature icon={Globe} tone="gold" title={t('landing.sectionBharat')} body={t('landing.sectionBharatBody')} delay={0.3} />
          </div>
        </div>
      </section>

      {/* ── The loop, on dark ───────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-[#2b2439] py-20 sm:py-28">
        <div
          className={cn('mesh-dense pointer-events-none absolute inset-0 opacity-50', !reduceMotion && 'drift')}
          aria-hidden="true"
        />
        <div className="grain absolute inset-0" aria-hidden="true" />

        <div className="relative mx-auto max-w-5xl px-4 sm:px-6">
          <FadeIn>
            <div className="text-center">
              <p className="text-xs font-bold tracking-[0.25em] text-white/50 uppercase">
                Scan · Speak · Remember · Act
              </p>
              <h2 className="mt-5 font-[family-name:var(--font-display)] text-4xl leading-tight text-white sm:text-6xl">
                {t('brand.promise')}
              </h2>
            </div>
          </FadeIn>

          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Scan', body: 'A code brings up everything.', icon: ScanLine },
              { label: 'Speak', body: 'Say the sale out loud.', icon: Mic },
              { label: 'Remember', body: 'It is written down for good.', icon: Brain },
              { label: 'Act', body: 'Vyapio says what needs doing.', icon: Sparkles },
            ].map((step, index) => (
              <FadeIn key={step.label} delay={index * 0.07}>
                <div className="group relative h-full overflow-hidden rounded-[var(--radius-card)] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-sm transition-colors hover:bg-white/[0.07]">
                  <span className="absolute top-4 right-4 text-4xl leading-none font-extrabold text-white/[0.07] tabular">
                    {index + 1}
                  </span>
                  <step.icon className="size-5 text-[var(--color-accent)]" aria-hidden="true" />
                  <p className="mt-4 text-base font-bold text-white">{step.label}</p>
                  <p className="mt-1 text-sm leading-snug text-white/55">{step.body}</p>
                </div>
              </FadeIn>
            ))}
          </div>

          {/* The one claim most products get wrong. */}
          <FadeIn delay={0.3}>
            <div className="mx-auto mt-14 flex max-w-3xl flex-col items-center gap-4 rounded-[var(--radius-panel)] border border-white/10 bg-white/[0.03] p-8 text-center backdrop-blur-sm">
              <span className="inline-flex items-center gap-2 rounded-full bg-[var(--color-warning)]/15 px-3 py-1.5 text-xs font-semibold text-[var(--color-warning)]">
                <WifiOff className="size-3.5" aria-hidden="true" />
                Works without a network
              </span>
              <p className="text-lg leading-relaxed text-white/80">
                Record a sale with no signal and Vyapio keeps it safe on the phone, tells you it is
                still waiting, and syncs the moment you are back.{' '}
                <span className="text-white">
                  It never claims something is saved when it is not.
                </span>
              </p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-t border-[var(--color-line)] py-24 sm:py-32">
        <div
          className={cn('mesh pointer-events-none absolute inset-0', !reduceMotion && 'drift-slow')}
          aria-hidden="true"
        />

        <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-8 px-4 text-center sm:px-6">
          <LogoMark size={96} />
          <h2 className="font-[family-name:var(--font-display)] text-5xl leading-[0.95] text-[var(--color-ink)] sm:text-7xl">
            {t('landing.finalCta')}
          </h2>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              to="/signup"
              size="lg"
              icon={<ArrowRight className="size-4" />}
              className="h-14 px-8 text-base shadow-[var(--shadow-lift)]"
            >
              {t('landing.finalCtaButton')}
            </Button>
            {appConfig.demoMode ? (
              <Button
                variant="outline"
                size="lg"
                className="h-14 px-8 text-base"
                onClick={() => void openDemo()}
                loading={loadingDemo}
              >
                {t('landing.ctaDemo')}
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--color-line)] py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-4 text-center sm:px-6">
          <Logo size="sm" />
          <p className="text-sm text-[var(--color-muted)]">{t('brand.tagline')}</p>
        </div>
      </footer>
    </PageTransition>
  );
}

const TONES = {
  primary: {
    chip: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]',
    glow: 'bg-[var(--color-primary)]/10',
  },
  accent: {
    chip: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
    glow: 'bg-[var(--color-accent)]/10',
  },
  gold: {
    chip: 'bg-[var(--color-gold-soft)] text-[var(--color-gold)]',
    glow: 'bg-[var(--color-gold)]/10',
  },
} as const;

function Feature({
  icon: Icon,
  tone,
  title,
  body,
  delay,
}: {
  icon: typeof ScanLine;
  tone: keyof typeof TONES;
  title: string;
  body: string;
  delay: number;
}) {
  const { chip, glow } = TONES[tone];

  return (
    <FadeIn delay={delay}>
      {/*
        The card under the cursor should be the obvious one.

        Four things move together — it rises, it gains a plum ring, its shadow
        deepens, and its ground warms towards lavender. Any one of them on its
        own is the kind of change you only notice if you already know to look
        for it, which is how this started: a declared transform that was never
        applied, so the entire hover was a hairline going a shade darker.

        Sitting beside five cards that have not moved is what does the work.
      */}
      <div className="group lit relative h-full overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6 transition-[transform,box-shadow,border-color,background-color] duration-200 hover:-translate-y-1.5 hover:border-transparent hover:bg-[var(--color-lavender)]/45 hover:ring-2 hover:ring-[var(--color-primary)]/35 hover:shadow-[0_18px_40px_-12px_rgb(43_36_57_/_0.22)]">
        {/* A colour wash that warms on hover. */}
        <span
          className={cn(
            'pointer-events-none absolute -top-12 -right-12 size-40 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100',
            glow,
          )}
          aria-hidden="true"
        />

        <span
          className={cn(
            'relative inline-flex size-11 items-center justify-center rounded-[var(--radius-control)] transition-transform duration-200 group-hover:scale-110',
            chip,
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h3 className="relative mt-5 text-lg leading-snug font-bold text-[var(--color-ink)]">
          {title}
        </h3>
        <p className="relative mt-2 text-sm leading-relaxed text-[var(--color-muted)]">{body}</p>
      </div>
    </FadeIn>
  );
}

function SunGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
    </svg>
  );
}

function MoonGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
    </svg>
  );
}
