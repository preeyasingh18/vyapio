import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * Data fetching.
 *
 * A small hook rather than a query library, because the app's needs are modest:
 * fetch on mount, refetch on demand, and never set state after unmount. What it
 * does add is `offline` as a first-class state, distinct from an error — the UI
 * treats "we couldn't reach the server" very differently from "the server said
 * no".
 */

export type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** True when the failure was a network failure. */
  offline: boolean;
  refetch: () => Promise<void>;
  /** Optimistic local update without a round trip. */
  setData: (updater: T | ((current: T | null) => T)) => void;
};

export function useQuery<T>(
  path: string | null,
  options: { query?: Record<string, string | number | boolean | undefined>; enabled?: boolean } = {},
): QueryState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);

  // Serialised so the effect does not re-run on every render from a fresh
  // object literal at the call site.
  const queryKey = JSON.stringify(options.query ?? {});
  const enabled = options.enabled ?? true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const run = useCallback(async () => {
    if (!path || !enabled) {
      setLoading(false);
      return;
    }

    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;

    setLoading(true);
    setError(null);

    try {
      const parsed = JSON.parse(queryKey) as Record<string, string | number | boolean | undefined>;
      const result = await api.get<T>(path, { query: parsed, signal: next.signal });
      if (!mounted.current || next.signal.aborted) return;
      setDataState(result);
    } catch (caught) {
      if (!mounted.current || next.signal.aborted) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof ApiError ? caught : new ApiError({
        code: 'INTERNAL',
        message: 'Something went wrong. Please try again.',
        status: 500,
      }));
    } finally {
      if (mounted.current && !next.signal.aborted) setLoading(false);
    }
  }, [path, queryKey, enabled]);

  useEffect(() => {
    void run();
  }, [run]);

  const setData = useCallback((updater: T | ((current: T | null) => T)) => {
    setDataState((current) =>
      typeof updater === 'function' ? (updater as (value: T | null) => T)(current) : updater,
    );
  }, []);

  return {
    data,
    loading,
    error,
    offline: error?.offline ?? false,
    refetch: run,
    setData,
  };
}

/**
 * Mutations.
 *
 * Tracks its own pending and error state so a form can disable its submit
 * button and render a field-level message without wiring that up each time.
 */
export function useMutation<TInput, TResult>(
  mutate: (input: TInput) => Promise<TResult>,
): {
  run: (input: TInput) => Promise<TResult | null>;
  loading: boolean;
  error: ApiError | null;
  reset: () => void;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      setLoading(true);
      setError(null);
      try {
        const result = await mutate(input);
        return result;
      } catch (caught) {
        const apiError =
          caught instanceof ApiError
            ? caught
            : new ApiError({
                code: 'INTERNAL',
                message: 'Something went wrong. Please try again.',
                status: 500,
              });
        if (mounted.current) setError(apiError);
        return null;
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [mutate],
  );

  const reset = useCallback(() => setError(null), []);

  return { run, loading, error, reset };
}
