import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Keyboard, Mic, RotateCcw, Sparkles, TriangleAlert, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button, Textarea } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { Waveform } from '@/components/motion';
import { DraftReview } from './DraftReview';
import { useT } from '@/app/providers/I18nProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useOffline } from '@/app/providers/OfflineProvider';
import { useSpeech } from '@/hooks/useSpeech';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { languageMeta } from '@shared/common';
import type { TransactionDraft } from '@shared/ai';
import { cn } from '@/lib/cn';

/**
 * Speak a transaction.
 *
 * Four states, and the third one is the product:
 *
 *   idle → listening → understanding → **ready for review** → saved
 *
 * The review step is not a formality. Every number on it is editable, every
 * doubt the parser had is printed in plain language, and nothing is written
 * until the shopkeeper taps Confirm. That is what makes it safe to let a model
 * anywhere near a khata.
 */

type ParseResponse = { draft: TransactionDraft };

type Phase = 'idle' | 'listening' | 'understanding' | 'review';

export default function VoicePage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { vendor } = useAuth();
  const { online, enqueue } = useOffline();

  const voiceLanguage = vendor?.voiceLanguage ?? 'hi';
  const meta = languageMeta(voiceLanguage);
  const speech = useSpeech(meta.bcp47);

  const [phase, setPhase] = useState<Phase>('idle');
  const [draft, setDraft] = useState<TransactionDraft | null>(null);
  const [typed, setTyped] = useState('');
  const [typingMode, setTypingMode] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ── Parse ─────────────────────────────────────────────────────────────── */

  const parse = async (transcript: string) => {
    if (!transcript.trim()) return;
    setPhase('understanding');
    try {
      const result = await api.post<ParseResponse>('/voice/parse', {
        transcript: transcript.trim(),
        language: voiceLanguage,
      });
      setDraft(result.draft);
      setPhase('review');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
      setPhase('idle');
    }
  };

  // Parse as soon as the recogniser stops and we have words.
  useEffect(() => {
    if (phase === 'listening' && !speech.listening && speech.transcript.trim()) {
      void parse(speech.transcript);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.listening, speech.transcript, phase]);

  const startListening = async () => {
    speech.reset();
    setDraft(null);
    setPhase('listening');
    await speech.start();
  };

  const restart = () => {
    speech.reset();
    setDraft(null);
    setTyped('');
    setTypingMode(false);
    setPhase('idle');
  };

  /* ── Save ──────────────────────────────────────────────────────────────── */

  const confirm = async () => {
    if (!draft || saving) return;

    /**
     * A name nobody has saved yet is still a customer.
     *
     * The draft already says "we'll create them on confirm" when the spoken
     * name matches nobody — so confirm has to actually do it. Refusing here
     * made that promise a lie and left the shopkeeper on a dead screen: the
     * only way out was to abandon the sale, go and add the person by hand, and
     * say the whole thing again.
     */
    const needsCreating = !draft.customerId && draft.customerIsNew && draft.customerName.trim();

    if (!draft.customerId && !needsCreating) {
      toast.error(t('voice.pickCustomer'));
      return;
    }

    /**
     * Only what the shop can actually hand over is sold.
     *
     * Out-of-stock lines stay on the screen so the shopkeeper can see the whole
     * request, but they are not part of the sale: a line of zero would be a
     * record of goods that never moved, and it would fail the ledger's own
     * arithmetic checks anyway. A short line is sold at the quantity that fits.
     */
    const sellable = draft.items.filter((item) => item.fulfilledQuantity > 0);

    if (sellable.length === 0) {
      toast.error('Nothing in this order is in stock');
      return;
    }

    const total = sellable.reduce((sum, item) => sum + item.lineTotal, 0) - draft.discount;

    /**
     * The customer is created first, and only then the sale.
     *
     * Two writes rather than one, so the order matters: a sale cannot be
     * recorded against somebody who does not exist yet. If the first succeeds
     * and the second fails, the shop is left with a new customer and no sale —
     * which is recoverable by saying it again, and is the right way round. The
     * reverse would be a sale on a khata nobody can open.
     */
    let customerId = draft.customerId;

    if (!customerId) {
      if (!online) {
        toast.error(t('voice.newCustomerOffline'));
        return;
      }

      setSaving(true);
      try {
        /**
         * Ask before creating.
         *
         * The draft decided this person was new when it was prepared, which may
         * have been minutes ago and was matched against a snapshot. Asking again
         * here means the decision is made against the book as it stands at the
         * moment of writing — and a name the parser did not quite resolve does
         * not become a second copy of a customer the shop already has.
         */
        const lookup = await api.post<{
          found: boolean;
          customer?: { customerId: string; name: string };
          candidates?: Array<{ customerId: string; name: string }>;
        }>('/customers/resolve', { name: draft.customerName.trim() });

        if (lookup.found && lookup.customer) {
          customerId = lookup.customer.customerId;
        } else if (lookup.candidates && lookup.candidates.length > 0) {
          // Several people answer to this name. Picking one would put the money
          // on somebody's khata at random.
          setSaving(false);
          toast.error(t('voice.pickWhichCustomer', { name: draft.customerName.trim() }));
          return;
        } else {
          const created = await api.post<{ customer: { customerId: string; name: string } }>(
            '/customers',
            { name: draft.customerName.trim() },
          );
          customerId = created.customer.customerId;
          toast.success(t('customers.added'), created.customer.name);
        }
      } catch (caught) {
        setSaving(false);
        toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
        return;
      }
    }

    const payload = {
      customerId,
      items: sellable.map((item) => ({
        ...(item.productId ? { productId: item.productId } : {}),
        name: item.name,
        quantity: item.fulfilledQuantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
      })),
      discount: draft.discount,
      // Change is handed back across the counter, not recorded as an
      // overpayment: a sale where paid exceeds the total has no meaning on a
      // khata, and the ledger requires paid + outstanding to equal the total.
      paid: Math.min(draft.paid, Math.max(0, total)),
      paymentMethod: draft.paymentMethod,
      note: '',
      source: 'voice' as const,
      transcript: draft.transcript,
    };

    if (!online) {
      enqueue({
        kind: 'transaction',
        payload,
        label: `${draft.customerName} · ${formatMoney(draft.total)}`,
      });
      toast.info(t('offline.notSavedYet'), `${draft.customerName} · ${formatMoney(draft.total)}`);
      navigate('/app');
      return;
    }

    setSaving(true);
    try {
      /**
       * Keyed to the draft, not to the click.
       *
       * A fresh uuid per call defeats the very guard it is passed to: two taps
       * on Confirm arrive as two unrelated sales and the stock comes off twice.
       * The draft id is stable for as long as this draft exists, so a double
       * tap, a retry after a timeout and a resend all carry the same key and
       * the server collapses them into one.
       */
      await api.post('/transactions', payload, { idempotencyKey: `draft:${draft.draftId}` });
      toast.success(t('sales.recorded'), `${draft.customerName} · ${formatMoney(draft.total)}`);
      navigate(`/app/customers/${customerId}`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  /** The mark breathes while the app is actually doing something. */
  const working = phase === 'listening' || phase === 'understanding';

  const liveText = `${speech.transcript} ${speech.interim}`.trim();

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <PageHeader
        title={t('voice.title')}
        back
        actions={
          phase !== 'idle' ? (
            <Button variant="ghost" size="icon" onClick={restart} aria-label={t('voice.speakAgain')}>
              <RotateCcw className="size-5" aria-hidden="true" />
            </Button>
          ) : undefined
        }
      />

      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <AnimatePresence mode="wait">
          {phase === 'review' && draft ? (
            <motion.div
              key="review"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              <DraftReview
                draft={draft}
                onChange={setDraft}
                onConfirm={() => void confirm()}
                onSpeakAgain={restart}
                saving={saving}
                online={online}
              />
            </motion.div>
          ) : (
            <motion.div
              key="capture"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              {/* ── The stage ───────────────────────────────────────────── */}
              <div
                className={cn(
                  'relative flex w-full flex-col items-center overflow-hidden rounded-[2rem] px-6 py-10 transition-colors duration-500',
                  phase === 'listening'
                    ? 'bg-[var(--color-accent-soft)]'
                    : phase === 'understanding'
                      ? 'bg-[var(--color-primary-soft)]'
                      : 'bg-[var(--color-sunken)]',
                )}
              >
                {/* Concentric rings that breathe while listening. */}
                {phase === 'listening' ? (
                  <>
                    <span
                      className="breathe absolute top-1/2 left-1/2 size-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-accent)]/10"
                      aria-hidden="true"
                    />
                    <span
                      className="breathe absolute top-1/2 left-1/2 size-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-accent)]/15"
                      style={{ animationDelay: '0.4s' }}
                      aria-hidden="true"
                    />
                  </>
                ) : null}

                <div className="relative">
                  <LogoMark size={110} pulse={working} />
                </div>

                <motion.p
                  key={phase}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="relative mt-5 text-xl font-bold text-[var(--color-ink)]"
                >
                  {phase === 'listening'
                    ? t('voice.listening')
                    : phase === 'understanding'
                      ? t('voice.understanding')
                      : t('voice.tapToSpeak')}
                </motion.p>

                <p className="relative mt-1.5 text-center text-sm text-[var(--color-muted)]">
                  {phase === 'listening' ? t('voice.listeningHint') : `Speaking ${meta.native}`}
                </p>

                {/* Driven by the real microphone signal, not a timer. */}
                {phase === 'listening' ? (
                  <Waveform levels={speech.levels} active className="relative mt-5 w-full max-w-xs" />
                ) : null}

                {phase === 'understanding' ? (
                  <div className="relative mt-5 flex gap-1.5">
                    {[0, 1, 2].map((index) => (
                      <motion.span
                        key={index}
                        className="size-2 rounded-full bg-[var(--color-primary)]"
                        animate={{ opacity: [0.3, 1, 0.3], y: [0, -4, 0] }}
                        transition={{ duration: 1, repeat: Infinity, delay: index * 0.15 }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              {/* ── Live transcript ─────────────────────────────────────── */}
              <AnimatePresence>
                {liveText && phase !== 'understanding' ? (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="w-full overflow-hidden"
                  >
                    <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
                      <p className="mb-1.5 text-[11px] font-bold tracking-widest text-[var(--color-muted)] uppercase">
                        Heard so far
                      </p>
                      <p className="text-base leading-relaxed text-[var(--color-ink)]">
                        {speech.transcript}{' '}
                        <span className="text-[var(--color-faint)]">{speech.interim}</span>
                      </p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {/* ── Example, while idle ─────────────────────────────────── */}
              {phase === 'idle' && !liveText && !typingMode ? (
                <div className="mt-4 flex w-full gap-2.5 rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] p-3.5">
                  <Sparkles
                    className="mt-0.5 size-3.5 shrink-0 text-[var(--color-accent)]"
                    aria-hidden="true"
                  />
                  <p className="text-sm leading-relaxed text-[var(--color-muted)]">
                    {t('voice.example')}
                  </p>
                </div>
              ) : null}

              {/* ── Failure modes, each with a way forward ──────────────── */}
              {speech.error ? (
                <div className="mt-4 w-full rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)] p-4">
                  <div className="flex gap-3">
                    <TriangleAlert
                      className="mt-0.5 size-5 shrink-0 text-[var(--color-warning)]"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="text-sm font-bold text-[var(--color-ink)]">
                        {speech.error === 'denied'
                          ? t('voice.micDenied')
                          : speech.error === 'unsupported'
                            ? t('voice.notSupported')
                            : speech.error === 'no-speech'
                              ? t('voice.noSpeech')
                              : t('errors.generic')}
                      </p>
                      <p className="mt-1 text-sm leading-snug text-[var(--color-muted)]">
                        {speech.error === 'denied'
                          ? t('voice.micDeniedBody')
                          : speech.error === 'unsupported'
                            ? t('voice.notSupportedBody')
                            : t('voice.example')}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* ── Typing: a first-class path, not a consolation ───────── */}
              <AnimatePresence>
                {typingMode ? (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="w-full overflow-hidden"
                  >
                    <div className="mt-4 space-y-3">
                      <Textarea
                        label="Type the sale"
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                        placeholder={t('voice.example')}
                        autoFocus
                      />
                      <Button
                        size="lg"
                        block
                        disabled={!typed.trim()}
                        onClick={() => void parse(typed)}
                      >
                        {t('common.next')}
                      </Button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {/* ── Controls ────────────────────────────────────────────── */}
              <div className="mt-8 flex w-full flex-col items-center gap-4">
                {phase === 'listening' ? (
                  <button
                    type="button"
                    onClick={speech.stop}
                    className="flex size-20 items-center justify-center rounded-full bg-[var(--color-danger)] text-white shadow-[var(--shadow-lift)] transition-transform active:scale-95"
                    aria-label="Stop listening"
                  >
                    <X className="size-8" aria-hidden="true" />
                  </button>
                ) : phase === 'understanding' ? (
                  <div className="h-20" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    onClick={() => void startListening()}
                    disabled={!speech.supported}
                    className="group relative flex size-20 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--shadow-lift)] transition-transform active:scale-95 disabled:opacity-40"
                    aria-label={t('voice.tapToSpeak')}
                  >
                    <span
                      className="absolute inset-0 rounded-full bg-[var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-20 group-hover:blur-xl"
                      aria-hidden="true"
                    />
                    <Mic className="relative size-8" aria-hidden="true" />
                  </button>
                )}

                {!typingMode ? (
                  <button
                    type="button"
                    onClick={() => setTypingMode(true)}
                    className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
                  >
                    <Keyboard className="size-4" aria-hidden="true" />
                    {t('voice.typeInstead')}
                  </button>
                ) : null}

                {/* Names the recognition engine, so a browser-quality result is
                    never mistaken for Amazon Transcribe. */}
                <p className="text-center text-xs text-[var(--color-faint)]">
                  {speech.supported ? t('voice.engineBrowser') : t('voice.notSupported')}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
