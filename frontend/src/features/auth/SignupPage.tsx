import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';
import { Button, Input, Select } from '@/components/ui';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { ApiError } from '@/lib/api';
import { BUSINESS_CATEGORIES, LANGUAGES, type BusinessCategory, type Language } from '@shared/common';

/**
 * Shop-keeper sign-up.
 *
 * One screen, not a wizard: every field here is something the shopkeeper
 * already knows, and splitting them across steps would only add taps. The
 * *interesting* questions are asked afterwards in onboarding.
 */

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

export default function SignupPage() {
  const t = useT();
  const { language: uiLanguage } = useI18n();
  const navigate = useNavigate();
  const { signup } = useAuth();

  const [form, setForm] = useState({
    ownerName: '',
    shopName: '',
    phone: '',
    email: '',
    password: '',
    category: 'kirana' as BusinessCategory,
    city: '',
    language: uiLanguage as Language,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await signup(form);
      if (result.requiresVerification) {
        navigate('/verify', { state: { email: form.email } });
      } else {
        // Local auth verifies immediately, so send them straight to sign-in
        // rather than to a code screen with no code.
        navigate('/login', { state: { email: form.email } });
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setLoading(false);
    }
  };

  const issue = (path: string) => error?.issueFor(path);

  return (
    <AuthLayout
      title={t('auth.signupTitle')}
      subtitle={t('auth.signupSubtitle')}
      footer={
        <span className="text-[var(--color-muted)]">
          {t('auth.hasAccount')}{' '}
          <Link to="/login" className="font-semibold text-[var(--color-primary)] hover:underline">
            {t('auth.signInInstead')}
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          label={t('auth.name')}
          value={form.ownerName}
          onChange={(event) => set('ownerName', event.target.value)}
          autoComplete="name"
          required
          {...(issue('ownerName') ? { error: issue('ownerName') } : {})}
        />

        <Input
          label={t('auth.shopName')}
          value={form.shopName}
          onChange={(event) => set('shopName', event.target.value)}
          autoComplete="organization"
          required
          {...(issue('shopName') ? { error: issue('shopName') } : {})}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            type="tel"
            label={t('auth.phone')}
            value={form.phone}
            // Digits only, capped at ten: the field already shows +91, so a
            // pasted "+91 98765 43210" would otherwise be stored with the
            // country code twice over.
            onChange={(event) => set('phone', event.target.value.replace(/\D/g, '').slice(0, 10))}
            autoComplete="tel"
            inputMode="numeric"
            prefix="+91"
            placeholder="98765 43210"
            required
            {...(issue('phone') ? { error: issue('phone') } : {})}
          />

          <Input
            label={t('auth.city')}
            value={form.city}
            onChange={(event) => set('city', event.target.value)}
            autoComplete="address-level2"
            required
            {...(issue('city') ? { error: issue('city') } : {})}
          />
        </div>

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

        <Select
          label={t('auth.language')}
          value={form.language}
          onChange={(event) => set('language', event.target.value as Language)}
        >
          {LANGUAGES.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.native} · {entry.label}
            </option>
          ))}
        </Select>

        <Input
          type="email"
          label={t('auth.email')}
          value={form.email}
          onChange={(event) => set('email', event.target.value)}
          autoComplete="email"
          inputMode="email"
          required
          {...(issue('email') ? { error: issue('email') } : {})}
        />

        <Input
          type="password"
          label={t('auth.password')}
          value={form.password}
          onChange={(event) => set('password', event.target.value)}
          autoComplete="new-password"
          hint="At least 8 characters, with an uppercase letter and a number"
          required
          {...(issue('password') ? { error: issue('password') } : {})}
        />

        {error && error.issues.length === 0 ? (
          <p
            className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
            role="alert"
          >
            {error.message}
          </p>
        ) : null}

        <Button type="submit" size="lg" block loading={loading}>
          {t('auth.signUp')}
        </Button>
      </form>
    </AuthLayout>
  );
}
