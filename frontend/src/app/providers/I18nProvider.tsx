import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { appConfig } from '@/app/config';
import { LANGUAGES, type Language } from '@shared/common';
import en from '@/locales/en.json';
import hi from '@/locales/hi.json';
import bn from '@/locales/bn.json';
import ta from '@/locales/ta.json';
import te from '@/locales/te.json';
import mr from '@/locales/mr.json';
import kn from '@/locales/kn.json';

/**
 * Translation.
 *
 * Deliberately small — a dictionary, a lookup and an English fallback — because
 * the requirement is that no user-facing string is hard-coded, not that we ship
 * an i18n framework.
 *
 * English is complete. Hindi is complete. The other five cover what a
 * shopkeeper reads constantly (navigation, home, scanner, voice, money, offline
 * status) and fall through to English for long-form marketing and onboarding
 * copy. A missing key resolves to English rather than rendering `nav.home`,
 * so partial coverage degrades into a bilingual screen rather than a broken one.
 */

type Dictionary = Record<string, unknown>;

const DICTIONARIES: Record<Language, Dictionary> = { en, hi, bn, ta, te, mr, kn };

/** Resolves "nav.home" against a nested dictionary. */
function lookup(dictionary: Dictionary, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((node, key) => {
    if (node && typeof node === 'object' && key in node) {
      return (node as Record<string, unknown>)[key];
    }
    return undefined;
  }, dictionary);

  return typeof value === 'string' ? value : undefined;
}

/** Replaces {name} placeholders. */
function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: TranslateFn;
  /** BCP-47 tag for Intl formatting and the html lang attribute. */
  locale: string;
  languages: typeof LANGUAGES;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(appConfig.storageKeys.language);
    if (stored && stored in DICTIONARIES) return stored as Language;
  } catch {
    // Storage unavailable.
  }

  // Fall back to the browser's preference when it is one we speak.
  const preferred = navigator.languages ?? [navigator.language];
  for (const tag of preferred) {
    const base = tag.split('-')[0];
    if (base && base in DICTIONARIES) return base as Language;
  }
  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(appConfig.storageKeys.language, next);
    } catch {
      // Preference is not persisted, but the session still switches.
    }
  }, []);

  const meta = useMemo(
    () => LANGUAGES.find((entry) => entry.code === language) ?? LANGUAGES[0],
    [language],
  );

  // Screen readers and `lang`-sensitive CSS both need this to be accurate.
  useEffect(() => {
    document.documentElement.lang = meta.bcp47;
  }, [meta.bcp47]);

  const t = useCallback<TranslateFn>(
    (key, values) => {
      const translated = lookup(DICTIONARIES[language], key) ?? lookup(DICTIONARIES.en, key);
      if (translated === undefined) {
        // A missing key is a bug; surface it loudly in development and fall
        // back to the last path segment in production rather than showing
        // "nav.home" to a shopkeeper.
        if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`);
        return key.split('.').pop() ?? key;
      }
      return interpolate(translated, values);
    },
    [language],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, t, locale: meta.bcp47, languages: LANGUAGES }),
    [language, setLanguage, t, meta.bcp47],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

/** Convenience hook for the common case. */
export function useT(): TranslateFn {
  return useI18n().t;
}
