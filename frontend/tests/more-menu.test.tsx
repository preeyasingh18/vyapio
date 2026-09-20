import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitForElementToBeRemoved } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { MoreMenu } from '@/components/layout/MoreMenu';

/**
 * The way out to everything the five bottom tabs could not hold.
 *
 * On a phone this is the only route to Orders, Reports, Payments and Settings,
 * so the thing to protect is that it opens and that every one of those is
 * inside it. It used to be a sixth item in a five-column bottom bar, which
 * wrapped it onto a row of its own underneath the bar.
 */

function mount() {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <MemoryRouter>
          <MoreMenu />
        </MemoryRouter>
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('the more menu', () => {
  it('opens from a labelled button', () => {
    mount();

    const trigger = screen.getByRole('button', { name: /more/i });
    // An icon-only control, so the name has to come from somewhere.
    expect(trigger).toHaveAccessibleName();

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('holds every screen the bottom tabs leave out', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /more/i }));

    for (const [name, href] of [
      ['Orders', '/app/orders'],
      ['Shop Pulse', '/app/pulse'],
      ['AI Assistant', '/app/assistant'],
      ['Shop Memory', '/app/memory'],
      ['Payments', '/app/payments'],
      ['Reports', '/app/reports'],
      ['Settings', '/app/settings'],
    ] as const) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  it('carries the theme toggle, which has nowhere else to live on a phone', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /more/i }));

    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
  });

  it('closes when a destination is chosen', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /more/i }));

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));

    // The sheet animates out, so it lingers in the DOM for a moment after the
    // close — waiting for its removal is the assertion, not its absence now.
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
  });

  it('stays out of the way on large screens, where the sidebar lists these', () => {
    mount();
    expect(screen.getByRole('button', { name: /more/i }).className).toContain('lg:hidden');
  });
});
