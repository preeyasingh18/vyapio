import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  CloudOff,
  Cloud,
  LogOut,
  Monitor,
  Moon,
  Sun,
} from 'lucide-react';
import { PageBody, PageHeader, SectionHeading } from '@/components/layout/PageHeader';
import { Button, Card, Select } from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useTheme, type ThemePreference } from '@/app/providers/ThemeProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { api, ApiError } from '@/lib/api';
import { LANGUAGES, type Language } from '@shared/common';
import { cn } from '@/lib/cn';

/**
 * Settings.
 *
 * Also the honest disclosure screen: the connection section spells out, per
 * subsystem, whether this environment is talking to real AWS or running
 * locally. A shopkeeper evaluating whether their data is backed up deserves a
 * straight answer rather than an inference from a small badge.
 */
export default function SettingsPage() {
  const t = useT();
  const { language, setLanguage } = useI18n();
  const { preference, setPreference } = useTheme();
  const { vendor, user, runtime, logout, setVendor } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [savingVoice, setSavingVoice] = useState(false);

  const setVoiceLanguage = async (next: Language) => {
    setSavingVoice(true);
    try {
      const result = await api.patch<{ vendor: typeof vendor }>('/auth/vendor', {
        voiceLanguage: next,
      });
      if (result.vendor) setVendor(result.vendor);
      toast.success('Voice language updated');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setSavingVoice(false);
    }
  };

  const signOut = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const themes: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
    { value: 'light', label: t('settings.themeLight'), icon: Sun },
    { value: 'dark', label: t('settings.themeDark'), icon: Moon },
    { value: 'system', label: t('settings.themeSystem'), icon: Monitor },
  ];

  return (
    <PageTransition>
      <PageHeader title={t('settings.title')} />

      <PageBody>
        {/* ── Appearance ────────────────────────────────────────────────── */}
        <SectionHeading title={t('settings.appearance')} />
        <Card className="p-4">
          <div className="grid grid-cols-3 gap-2">
            {themes.map((option) => {
              const active = preference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPreference(option.value)}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-[var(--radius-field)] border p-3.5 transition-colors',
                    active
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]'
                      : 'border-[var(--color-line)] hover:bg-[var(--color-sunken)]',
                  )}
                  aria-pressed={active}
                >
                  <option.icon
                    className={cn(
                      'size-5',
                      active ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted)]',
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-xs font-semibold text-[var(--color-ink)]">
                    {option.label}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* ── Language ──────────────────────────────────────────────────── */}
        <SectionHeading title={t('nav.language')} className="mt-7" />
        <Card className="space-y-4 p-4">
          <Select
            label={t('settings.uiLanguage')}
            value={language}
            onChange={(event) => setLanguage(event.target.value as Language)}
          >
            {LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.native} · {entry.label}
              </option>
            ))}
          </Select>

          <Select
            label={t('settings.voiceLanguage')}
            value={vendor?.voiceLanguage ?? 'hi'}
            disabled={savingVoice}
            onChange={(event) => void setVoiceLanguage(event.target.value as Language)}
            hint={t('settings.voiceLanguageHint')}
          >
            {LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.native} · {entry.label}
              </option>
            ))}
          </Select>
        </Card>

        {/* ── Shop ──────────────────────────────────────────────────────── */}
        {vendor ? (
          <>
            <SectionHeading title={t('settings.shopDetails')} className="mt-7" />
            <Card className="divide-y divide-[var(--color-line)]">
              <Row label={t('auth.shopName')} value={vendor.shopName} />
              <Row label={t('auth.category')} value={vendor.category} />
              <Row label={t('auth.city')} value={vendor.city} />
              <Row label={t('auth.name')} value={vendor.ownerName} />
              <Row label={t('auth.email')} value={vendor.email} />
            </Card>
          </>
        ) : null}

        {/* ── Connection ────────────────────────────────────────────────── */}
        <SectionHeading title={t('settings.connection')} className="mt-7" />
        {runtime ? (
          <Card className="overflow-hidden">
            <div
              className={cn(
                'flex items-center gap-3 px-4 py-3',
                runtime.fullyProvisioned
                  ? 'bg-[var(--color-success-soft)]'
                  : 'bg-[var(--color-warning-soft)]',
              )}
            >
              {runtime.fullyProvisioned ? (
                <Cloud className="size-5 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
              ) : (
                <CloudOff
                  className="size-5 shrink-0 text-[var(--color-warning)]"
                  aria-hidden="true"
                />
              )}
              <div>
                <p
                  className={cn(
                    'text-sm font-bold',
                    runtime.fullyProvisioned
                      ? 'text-[var(--color-success)]'
                      : 'text-[var(--color-warning)]',
                  )}
                >
                  {runtime.fullyProvisioned ? t('runtime.connected') : t('runtime.localMode')}
                </p>
                <p className="text-xs text-[var(--color-ink-soft)]">
                  {runtime.stage} · {runtime.region}
                </p>
              </div>
            </div>

            {/* Per-subsystem truth. */}
            <div className="divide-y divide-[var(--color-line)]">
              {Object.entries(runtime.subsystems).map(([name, mode]) => (
                <div key={name} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[var(--color-ink-soft)] capitalize">{name}</span>
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-xs font-semibold',
                      mode === 'aws'
                        ? 'text-[var(--color-success)]'
                        : 'text-[var(--color-muted)]',
                    )}
                  >
                    {mode === 'aws' ? (
                      <>
                        <Check className="size-3.5" aria-hidden="true" />
                        AWS
                      </>
                    ) : (
                      'local'
                    )}
                  </span>
                </div>
              ))}

              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm text-[var(--color-ink-soft)]">Notifications</span>
                <span
                  className={cn(
                    'text-xs font-semibold',
                    runtime.notificationProvider === 'mock'
                      ? 'text-[var(--color-warning)]'
                      : 'text-[var(--color-success)]',
                  )}
                >
                  {runtime.notificationProvider}
                </span>
              </div>
            </div>

            {!runtime.fullyProvisioned ? (
              <p className="border-t border-[var(--color-line)] bg-[var(--color-sunken)] px-4 py-3 text-xs leading-snug text-[var(--color-muted)]">
                {t('runtime.localModeBody', { subsystems: runtime.localSubsystems.join(', ') })}
              </p>
            ) : null}

            {runtime.notificationProvider === 'mock' ? (
              <p className="border-t border-[var(--color-line)] bg-[var(--color-warning-soft)] px-4 py-3 text-xs leading-snug text-[var(--color-warning)]">
                {t('runtime.notificationsMock')}
              </p>
            ) : null}
          </Card>
        ) : null}

        {/* ── Account ───────────────────────────────────────────────────── */}
        <SectionHeading title={t('settings.account')} className="mt-7" />
        <Card className="p-4">
          <p className="text-sm text-[var(--color-ink)]">{user?.email}</p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">{user?.role}</p>

          <Button
            variant="outline"
            size="md"
            block
            className="mt-4"
            onClick={() => void signOut()}
            icon={<LogOut className="size-4" />}
          >
            {t('nav.signOut')}
          </Button>
        </Card>

        <p className="mt-8 text-center text-xs text-[var(--color-faint)]">
          {t('brand.name')} · {t('brand.tagline')}
        </p>
      </PageBody>
    </PageTransition>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
      <span className="truncate text-sm font-semibold text-[var(--color-ink)]">{value}</span>
    </div>
  );
}
