import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';
import { OpeningShop } from '@/components/brand/OpeningShop';
import { atLeast } from '@/lib/atLeast';

/**
 * The moment between tapping "enter" and the shop appearing.
 *
 * Signing in, fetching the shop and loading the dashboard is several requests.
 * A button that merely dims leaves the old page sitting there, and a
 * shopkeeper on a slow connection taps it again.
 */

function mount(ui: React.ReactElement) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('the opening screen', () => {
  it('says what is happening, not just that something is', () => {
    mount(<OpeningShop show />);
    expect(screen.getByText(/opening your shop/i)).toBeInTheDocument();
  });

  it('is announced, since it replaces the screen', () => {
    mount(<OpeningShop show />);
    // A sighted user sees the page change; without this a screen reader would
    // be told nothing at all.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('stays out of the way until it is needed', () => {
    mount(<OpeningShop show={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('how long it stays up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('holds long enough to be read when the work is instant', async () => {
    // Against a local API this finishes in under a frame, and an overlay that
    // appears and vanishes inside one reads as a glitch, not a transition.
    const done = vi.fn();
    void atLeast(Promise.resolve('ok'), 900).then(done);

    await vi.advanceTimersByTimeAsync(500);
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(done).toHaveBeenCalledWith('ok');
  });

  it('adds nothing to work that was already slower', async () => {
    // The floor must never become a delay on a connection that is genuinely
    // slow — that would punish exactly the shopkeeper it is meant to help.
    let settle: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const done = vi.fn();
    void atLeast(slow, 900).then(done);

    await vi.advanceTimersByTimeAsync(2000);
    expect(done).not.toHaveBeenCalled();

    settle('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledWith('ok');
  });

  it('lets a failure through rather than swallowing it', async () => {
    const caught = vi.fn();
    void atLeast(Promise.reject(new Error('no network')), 900).catch(caught);

    await vi.advanceTimersByTimeAsync(1000);
    expect(caught).toHaveBeenCalled();
  });
});
