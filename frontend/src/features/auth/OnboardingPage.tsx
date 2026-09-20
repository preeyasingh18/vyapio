import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Check, Mic, NotebookPen, ScanLine, Smartphone, Brain, Laptop } from 'lucide-react';
import { Button, Input, Select, Switch } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { useT } from '@/app/providers/I18nProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { api, ApiError } from '@/lib/api';
import { BUSINESS_CATEGORIES, LANGUAGES, type BusinessCategory, type Language } from '@shared/common';
import type { Vendor } from '@shared/entities';
import { cn } from '@/lib/cn';

/**
 * Onboarding.
 *
 * Four steps, and the middle two earn their place: step 2 tells us what we are
 * replacing, and step 3 is the only moment to explain the product loop before
 * the shopkeeper is dropped into an empty shop.
 */

const TOTAL_STEPS = 4;

const CATEGORY_LABELS: Record<BusinessCategory, string> = {
  kirana: 'Kirana / grocery',
  pharmacy: 'Pharmacy',
  hardware: 'Hardware',
  electronics: 'Electronics',
  tailor: 'Tailor',
  stationery: 'Stationery',
  salon: 'Salon',
  mechanic: 'Mechanic',
  restaurant: 'Restaurant',
  other: 'Other',
};

export default function OnboardingPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { vendor, setVendor, refreshSession } = useAuth();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    shopName: vendor?.shopName ?? '',
    category: (vendor?.category ?? 'kirana') as BusinessCategory,
    city: vendor?.city ?? '',
    language: (vendor?.language ?? 'en') as Language,
    voiceLanguage: (vendor?.voiceLanguage ?? 'hi') as Language,
    currentMethod: '',
    seedDemoData: false,
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const finish = async () => {
    setLoading(true);
    try {
      const result = await api.post<{ vendor: Vendor }>('/auth/onboarding', form);
      setVendor(result.vendor);
      await refreshSession();
      navigate('/app', { replace: true });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  const canAdvance =
    step !== 1 || (form.shopName.trim().length > 0 && form.city.trim().length > 0);

  return (
    <div className="warm-glow flex min-h-dvh flex-col bg-[var(--color-bg)]">
      {/* Progress: a bar rather than "1 of 4" alone, because a shopkeeper on a
          phone wants to see how much is left at a glance. */}
      <header className="px-4 pt-5 sm:px-6">
        <div className="mx-auto max-w-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--color-muted)]">
              {t('onboarding.step', { current: step, total: TOTAL_STEPS })}
            </span>
            {step < TOTAL_STEPS ? (
              <button
                type="button"
                onClick={() => setStep(TOTAL_STEPS)}
                className="text-xs font-semibold text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                {t('common.skip')}
              </button>
            ) : null}
          </div>

          <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-sunken)]">
            <motion.div
              className="h-full rounded-full bg-[var(--color-primary)]"
              animate={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
              transition={{ type: 'spring', stiffness: 260, damping: 30 }}
            />
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <div className="w-full max-w-lg">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === 1 ? (
                <Step
                  state="idle"
                  title={t('onboarding.step1Title')}
                  subtitle={t('onboarding.step1Subtitle')}
                >
                  <div className="space-y-4">
                    <Input
                      label={t('auth.shopName')}
                      value={form.shopName}
                      onChange={(event) => set('shopName', event.target.value)}
                      required
                    />
                    <Select
                      label={t('auth.category')}
                      value={form.category}
                      onChange={(event) => set('category', event.target.value as BusinessCategory)}
                    >
                      {BUSINESS_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {CATEGORY_LABELS[category]}
                        </option>
                      ))}
                    </Select>
                    <Input
                      label={t('auth.city')}
                      value={form.city}
                      onChange={(event) => set('city', event.target.value)}
                      required
                    />

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Select
                        label={t('settings.uiLanguage')}
                        value={form.language}
                        onChange={(event) => set('language', event.target.value as Language)}
                      >
                        {LANGUAGES.map((entry) => (
                          <option key={entry.code} value={entry.code}>
                            {entry.native}
                          </option>
                        ))}
                      </Select>

                      <Select
                        label={t('settings.voiceLanguage')}
                        value={form.voiceLanguage}
                        onChange={(event) => set('voiceLanguage', event.target.value as Language)}
                        hint={t('settings.voiceLanguageHint')}
                      >
                        {LANGUAGES.map((entry) => (
                          <option key={entry.code} value={entry.code}>
                            {entry.native}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                </Step>
              ) : step === 2 ? (
                <Step
                  state="thinking"
                  title={t('onboarding.step2Title')}
                  subtitle={t('onboarding.step2Subtitle')}
                >
                  <div className="grid gap-2.5">
                    {[
                      { value: 'notebook', label: t('onboarding.step2Notebook'), icon: NotebookPen },
                      { value: 'memory', label: t('onboarding.step2Memory'), icon: Brain },
                      { value: 'whatsapp', label: t('onboarding.step2Whatsapp'), icon: Smartphone },
                      { value: 'software', label: t('onboarding.step2Software'), icon: Laptop },
                    ].map((option) => {
                      const selected = form.currentMethod === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            set('currentMethod', option.value);
                            // Auto-advance: this question has no wrong answer,
                            // so a second tap on "Next" would be friction.
                            window.setTimeout(() => setStep(3), 220);
                          }}
                          className={cn(
                            'flex items-center gap-3 rounded-[var(--radius-card)] border p-4 text-left transition-colors',
                            selected
                              ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]'
                              : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-line-strong)]',
                          )}
                        >
                          <option.icon
                            className={cn(
                              'size-5 shrink-0',
                              selected ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted)]',
                            )}
                            aria-hidden="true"
                          />
                          <span className="flex-1 text-sm font-semibold text-[var(--color-ink)]">
                            {option.label}
                          </span>
                          {selected ? (
                            <Check className="size-4 text-[var(--color-primary)]" aria-hidden="true" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </Step>
              ) : step === 3 ? (
                <Step
                  state="memory"
                  title={t('onboarding.step3Title')}
                  subtitle={t('onboarding.step3Subtitle')}
                >
                  <div className="space-y-2.5">
                    {[
                      {
                        icon: ScanLine,
                        title: 'Scan',
                        body: 'One code brings up a customer and everything they have ever bought.',
                      },
                      {
                        icon: Mic,
                        title: 'Speak',
                        body: 'Say the sale out loud. Vyapio shows you what it heard before saving anything.',
                      },
                      {
                        icon: Brain,
                        title: 'Ask',
                        body: '"Who owes me money?" — answered from your own records, with the receipts.',
                      },
                    ].map((item) => (
                      <div
                        key={item.title}
                        className="flex gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
                      >
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-field)] bg-[var(--color-primary-soft)]">
                          <item.icon className="size-5 text-[var(--color-primary)]" aria-hidden="true" />
                        </span>
                        <div>
                          <p className="text-sm font-bold text-[var(--color-ink)]">{item.title}</p>
                          <p className="mt-0.5 text-sm leading-snug text-[var(--color-muted)]">
                            {item.body}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Step>
              ) : (
                <Step
                  state="success"
                  title={t('onboarding.step4Title')}
                  subtitle={t('onboarding.step4Subtitle')}
                >
                  <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
                    <Switch
                      checked={form.seedDemoData}
                      onChange={(value) => set('seedDemoData', value)}
                      label={t('onboarding.seedDemo')}
                      description="Adds sample customers, products and sales you can delete later."
                    />
                  </div>
                </Step>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <footer className="px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] sm:px-6">
        <div className="mx-auto flex max-w-lg gap-3">
          {step > 1 ? (
            <Button variant="outline" size="lg" onClick={() => setStep(step - 1)}>
              {t('common.back')}
            </Button>
          ) : null}

          {step < TOTAL_STEPS ? (
            <Button size="lg" block disabled={!canAdvance} onClick={() => setStep(step + 1)}>
              {t('common.next')}
            </Button>
          ) : (
            <Button
              size="lg"
              block
              loading={loading}
              onClick={() => void finish()}
              icon={<ArrowRight className="size-4" />}
            >
              {t('onboarding.finish')}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

function Step({
  title,
  subtitle,
  children,
}: {
  state: 'idle' | 'thinking' | 'memory' | 'success';
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-6 flex flex-col items-center text-center">
        <LogoMark size={56} />
        <h1 className="mt-4 font-[family-name:var(--font-display)] text-2xl leading-tight text-[var(--color-ink)] sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-sm text-sm text-[var(--color-muted)]">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
