import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';

/**
 * What the Settings screen says about where the shop's records live.
 *
 * This is the one claim on that screen a shopkeeper has to be able to trust,
 * and it was wrong: the headline asked "is every subsystem on AWS", so a shop
 * whose books were already in DynamoDB was told "Local mode — data is stored
 * on this machine and has not been sent to AWS", because speech recognition
 * happened to be running in the browser.
 */

let runtime: Record<string, unknown>;

vi.mock('@/hooks/useApi', () => ({
  useQuery: (path: string | null) => ({
    data: path === '/health' ? { runtime } : null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    setData: vi.fn(),
  }),
}));

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { userId: 'u1', email: 'demo@vyapio.app', role: 'SHOPKEEPER' },
    vendor: { vendorId: 'v1', shopName: 'Sharma Stores', city: 'Patna', language: 'en' },
    // The banner reads this from the auth context, not from a query.
    runtime,
    needsOnboarding: false,
    logout: vi.fn(),
    setVendor: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/providers/OfflineProvider', () => ({
  useOffline: () => ({ online: true, enqueue: vi.fn(), queue: [], syncing: false }),
}));

function make(subsystems: Record<string, string>) {
  return {
    stage: 'dev',
    region: 'ap-south-1',
    demoMode: true,
    subsystems,
    notificationProvider: 'mock',
    fullyProvisioned: Object.values(subsystems).every((mode) => mode === 'aws'),
    localSubsystems: Object.entries(subsystems)
      .filter(([, mode]) => mode === 'local')
      .map(([name]) => name),
  };
}

const ALL_AWS = {
  database: 'aws', auth: 'aws', ai: 'aws',
  transcribe: 'aws', textract: 'aws', storage: 'aws', events: 'aws',
};

async function mount() {
  const { default: SettingsPage } = await import('@/features/dashboard/SettingsPage');
  return render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  runtime = make(ALL_AWS);
});

describe('what Settings says about the shop’s records', () => {
  it('does not claim the data is on this machine when it is in DynamoDB', async () => {
    /**
     * The exact shape that was wrong: records in AWS, speech and document
     * reading still local.
     */
    runtime = make({ ...ALL_AWS, ai: 'local', transcribe: 'local', textract: 'local' });
    await mount();

    expect(screen.queryByText(/stored on this machine/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/has not been sent to AWS/i)).not.toBeInTheDocument();
  });

  it('says the records are in AWS, and lists what is still local', async () => {
    runtime = make({ ...ALL_AWS, ai: 'local', transcribe: 'local', textract: 'local' });
    await mount();

    expect(screen.getByText(/records are in AWS/i)).toBeInTheDocument();
    expect(screen.getByText(/ai, transcribe, textract/)).toBeInTheDocument();
  });

  it('still warns honestly when the records really are local', async () => {
    // The original message is correct here, and must not be softened.
    runtime = make({ ...ALL_AWS, database: 'local', auth: 'local', storage: 'local' });
    await mount();

    expect(screen.getByText(/stored on this machine/i)).toBeInTheDocument();
  });

  it('reads as connected once the records are in AWS', async () => {
    runtime = make({ ...ALL_AWS, ai: 'local' });
    await mount();

    expect(screen.getByText(/connected to aws/i)).toBeInTheDocument();
  });
});
