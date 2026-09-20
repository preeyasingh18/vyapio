import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  getTokens,
  setTokens,
  setUnauthenticatedHandler,
  fetchHealth,
  type RuntimeInfo,
  type Tokens,
} from '@/lib/api';
import type { Vendor } from '@shared/entities';
import type { Role } from '@shared/common';

/**
 * Session state.
 *
 * Holds the signed-in user, their shop, and the runtime description that drives
 * the "Local mode" badge. Everything the rest of the app needs to know about
 * *who* is asking lives here, so no screen has to reason about tokens.
 */

export type SessionUser = {
  userId: string;
  email: string;
  role: Role;
};

type AuthState = {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
  vendor: Vendor | null;
  needsOnboarding: boolean;
  /** For customer-app sessions: the (shop, profile) pairs they may read. */
  links: Array<{ vendorId: string; customerId: string }>;
  runtime: RuntimeInfo | null;
};

type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  demoLogin: () => Promise<void>;
  signup: (input: SignupInput) => Promise<{ requiresVerification: boolean }>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  setVendor: (vendor: Vendor) => void;
};

export type SignupInput = {
  ownerName: string;
  email: string;
  phone: string;
  password: string;
  shopName?: string;
  category?: string;
  city?: string;
  language?: string;
  role?: Role;
};

type SessionResponse = {
  tokens?: Tokens;
  user: SessionUser;
  vendor: Vendor | null;
  needsOnboarding: boolean;
  links?: Array<{ vendorId: string; customerId: string }>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    vendor: null,
    needsOnboarding: false,
    links: [],
    runtime: null,
  });

  const applySession = useCallback((session: SessionResponse) => {
    setState((current) => ({
      ...current,
      status: 'authenticated',
      user: session.user,
      vendor: session.vendor,
      needsOnboarding: session.needsOnboarding,
      links: session.links ?? [],
    }));
  }, []);

  const clearSession = useCallback(() => {
    setTokens(null);
    setState((current) => ({
      ...current,
      status: 'anonymous',
      user: null,
      vendor: null,
      needsOnboarding: false,
      links: [],
    }));
  }, []);

  /**
   * Restores the session on boot.
   *
   * The runtime description is fetched unconditionally — it is public, and the
   * landing page needs the "Local mode" badge before anyone signs in.
   */
  const refreshSession = useCallback(async () => {
    try {
      const health = await fetchHealth();
      setState((current) => ({ ...current, runtime: health.runtime }));
    } catch {
      // API unreachable. The app still renders; screens show their own errors.
    }

    if (!getTokens()?.accessToken) {
      setState((current) => ({ ...current, status: 'anonymous' }));
      return;
    }

    try {
      const session = await api.get<SessionResponse>('/auth/me');
      applySession(session);
    } catch {
      // An expired or revoked session: the client already tried to refresh.
      clearSession();
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    // Lets the API client drop the session when a refresh finally fails.
    setUnauthenticatedHandler(clearSession);
    void refreshSession();
    return () => setUnauthenticatedHandler(null);
  }, [clearSession, refreshSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await api.post<SessionResponse>(
        '/auth/login',
        { email, password },
        { anonymous: true },
      );
      if (session.tokens) setTokens(session.tokens);
      applySession(session);
    },
    [applySession],
  );

  const demoLogin = useCallback(async () => {
    const session = await api.post<SessionResponse>('/auth/demo-login', {}, { anonymous: true });
    if (session.tokens) setTokens(session.tokens);
    applySession(session);
  }, [applySession]);

  const signup = useCallback(async (input: SignupInput) => {
    const result = await api.post<{ requiresVerification: boolean }>('/auth/signup', input, {
      anonymous: true,
    });
    return { requiresVerification: result.requiresVerification };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Signing out locally is what matters; a failed server call must not
      // leave the user stuck in a session they asked to end.
    }
    clearSession();
  }, [clearSession]);

  const setVendor = useCallback((vendor: Vendor) => {
    setState((current) => ({
      ...current,
      vendor,
      needsOnboarding: !vendor.onboardingComplete,
    }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, demoLogin, signup, logout, refreshSession, setVendor }),
    [state, login, demoLogin, signup, logout, refreshSession, setVendor],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
