import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';

/**
 * Stopping the microphone.
 *
 * The screen keeps its own phase, separate from whether the recogniser is
 * running, and only one of the two ways listening can end moved it on: the one
 * with words in it. Stopping without saying anything closed the microphone and
 * left the screen on "Listening" for ever — so the stop button looked broken,
 * and pressing it again did exactly what it had already done.
 *
 * The mock is a real hook with real state, because the bug is about what the
 * screen does when that state changes.
 */

/** What the recogniser produces, set per test. */
let heard = '';

vi.mock('@/hooks/useSpeech', () => ({
  useSpeech: () => {
    const [listening, setListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    return {
      supported: true,
      listening,
      transcript,
      interim: '',
      levels: [],
      error: null,
      start: async () => {
        setTranscript(heard);
        setListening(true);
      },
      stop: () => setListening(false),
      reset: () => setTranscript(''),
    };
  },
}));

vi.mock('@/hooks/useApi', () => ({
  useQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn(), setData: vi.fn() }),
}));

vi.mock('@/app/providers/OfflineProvider', () => ({
  useOffline: () => ({ online: true, enqueue: vi.fn(), queue: [], syncing: false }),
}));

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { userId: 'u1', email: 'a@b.c', role: 'SHOPKEEPER' },
    vendor: { vendorId: 'v1', shopName: 'Sharma Stores', city: 'Patna', voiceLanguage: 'en' },
    needsOnboarding: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

async function mount() {
  const { default: VoicePage } = await import('@/features/voice/VoicePage');
  return render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter>
            <VoicePage />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

const stopButton = () => screen.queryByRole('button', { name: /stop listening/i });

beforeEach(() => {
  heard = '';
});

describe('stopping the microphone', () => {
  it('shows a way to stop once it is listening', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /tap to speak|speak/i }));

    expect(await screen.findByRole('button', { name: /stop listening/i })).toBeInTheDocument();
  });

  it('returns to the microphone when nothing was said', async () => {
    /**
     * The case that was stuck. The recogniser really had stopped; only the
     * screen had not, so the shopkeeper was left pressing a button that had
     * already done its job.
     */
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /tap to speak|speak/i }));
    fireEvent.click(await screen.findByRole('button', { name: /stop listening/i }));

    await waitFor(() => expect(stopButton()).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /tap to speak|speak/i })).toBeInTheDocument();
  });

  it('can be started again after a stop', async () => {
    // Which is the whole point of going back to idle rather than just hiding
    // the button.
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /tap to speak|speak/i }));
    fireEvent.click(await screen.findByRole('button', { name: /stop listening/i }));
    await waitFor(() => expect(stopButton()).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /tap to speak|speak/i }));
    expect(await screen.findByRole('button', { name: /stop listening/i })).toBeInTheDocument();
  });
});
