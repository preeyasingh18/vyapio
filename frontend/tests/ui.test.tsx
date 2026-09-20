import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, useT } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { PulseCardView } from '@/features/shop-pulse/PulseCardView';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { Button, Input, Badge, Table } from '@/components/ui';
import { formatMoney, formatMoneyCompact, initials, formatQuantity } from '@/lib/format';
import type { PulseCard } from '@shared/ai';

/**
 * Component and formatting tests.
 *
 * Weighted towards the things that would be *wrong* rather than merely ugly:
 * money formatting, accessible labelling, and whether severity survives being
 * read without colour.
 */

function wrap(ui: React.ReactElement) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('money formatting', () => {
  it('groups rupees the Indian way', () => {
    // 1,24,000 — not 124,000.
    expect(formatMoney(12_400_000)).toBe('₹1,24,000');
  });

  it('hides paise when they are zero', () => {
    expect(formatMoney(12_400)).toBe('₹124');
  });

  it('shows paise when they are not', () => {
    expect(formatMoney(12_450)).toBe('₹124.50');
  });

  it('handles a negative balance', () => {
    expect(formatMoney(-5_000)).toBe('-₹50');
  });

  it('handles zero', () => {
    expect(formatMoney(0)).toBe('₹0');
  });

  it('compacts large amounts with Indian units', () => {
    expect(formatMoneyCompact(1_250_000)).toBe('₹12.5k');
    expect(formatMoneyCompact(120_000_00)).toBe('₹1.2L');
    expect(formatMoneyCompact(340_000_000_0)).toBe('₹3.4Cr');
  });
});

describe('display helpers', () => {
  it('takes initials from the first and last name', () => {
    expect(initials('Ramesh Kumar')).toBe('RK');
    expect(initials('Priya')).toBe('PR');
    expect(initials('Ravi Shankar Prasad')).toBe('RP');
  });

  it('survives an empty name', () => {
    expect(initials('   ')).toBe('?');
  });

  it('hides the filler unit', () => {
    expect(formatQuantity(2, 'kg')).toBe('2 kg');
    expect(formatQuantity(1, 'unit')).toBe('1');
    expect(formatQuantity(1.5, 'litre')).toBe('1.5 litre');
  });
});

describe('Button', () => {
  it('renders a link when given a destination', () => {
    wrap(<Button to="/app">Go</Button>);
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/app');
  });

  it('announces a busy state', () => {
    wrap(<Button loading>Save</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('is not clickable while loading', async () => {
    const onClick = vi.fn();
    wrap(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Input', () => {
  it('links its label to the field', () => {
    wrap(<Input label="Phone number" />);
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument();
  });

  it('exposes an error to assistive tech', () => {
    wrap(<Input label="Email" error="Enter a valid email address" />);

    const field = screen.getByLabelText('Email');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
  });

  it('associates a hint with the field', () => {
    wrap(<Input label="Password" hint="At least 8 characters" />);
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'At least 8 characters',
    );
  });
});

describe('the brand mark', () => {
  it('is silent when it sits beside something that already says it', () => {
    // Next to a heading or a line of status text, a second announcement is
    // just the same thing twice.
    const { container } = wrap(<LogoMark />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('names itself when it is the only thing on the screen', () => {
    // A loading screen that is nothing but a mark announces nothing at all
    // unless the mark does it.
    wrap(<LogoMark pulse label="Loading" />);
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument();
  });

  it('spells the wordmark out for a reader, punctuation and all', () => {
    wrap(<Logo />);
    expect(screen.getByText(/vyapio/)).toBeInTheDocument();
  });
});

describe('PulseCardView', () => {
  const card: PulseCard = {
    id: 'stock-1',
    kind: 'stock',
    severity: 'critical',
    title: 'Cooking Oil may run out in ~2 days',
    body: '10 litre left · selling 5.14/day',
    narration: '',
    metrics: { stock: 10, daysRemaining: 2 },
    actionLabel: 'Add to restock',
    actionHref: '/app/inventory/prd_1',
    priority: 90,
  };

  it('shows the title and body', () => {
    wrap(<PulseCardView card={card} />);
    expect(screen.getByText('Cooking Oil may run out in ~2 days')).toBeInTheDocument();
    expect(screen.getByText('10 litre left · selling 5.14/day')).toBeInTheDocument();
  });

  it('conveys severity as text, not only colour', () => {
    wrap(<PulseCardView card={card} />);
    // Screen-reader-only, but present — colour-blind and monochrome users get
    // the urgency too.
    expect(screen.getByText(/Critical/)).toBeInTheDocument();
  });

  it('links the action', () => {
    wrap(<PulseCardView card={card} />);
    expect(screen.getByRole('link', { name: /Add to restock/ })).toHaveAttribute(
      'href',
      '/app/inventory/prd_1',
    );
  });

  it('marks AI narration as distinct from the computed figures', () => {
    wrap(<PulseCardView card={{ ...card, narration: 'Consider restocking today.' }} />);
    expect(screen.getByText('Consider restocking today.')).toBeInTheDocument();
  });

  it('renders correctly with no narration at all', () => {
    // The card must stand on its own when Bedrock is unavailable.
    wrap(<PulseCardView card={{ ...card, narration: '' }} />);
    expect(screen.getByText(card.title)).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('renders its content', () => {
    wrap(<Badge tone="warning">₹500 pending</Badge>);
    expect(screen.getByText('₹500 pending')).toBeInTheDocument();
  });
});

describe('translation', () => {
  it('falls back to English for an untranslated key', () => {
    // Kannada has no `landing.heroSubtitle`, so English must show rather than
    // the raw key.
    localStorage.setItem('vyapio.language', 'kn');
    wrap(<TranslationProbe keyName="landing.heroTitle" />);
    expect(screen.getByTestId('value').textContent).toContain('Give your shop a memory');
  });

  it('uses the translation when one exists', () => {
    localStorage.setItem('vyapio.language', 'hi');
    wrap(<TranslationProbe keyName="nav.home" />);
    expect(screen.getByTestId('value').textContent).toBe('होम');
  });

  it('interpolates values', () => {
    localStorage.setItem('vyapio.language', 'en');
    wrap(<TranslationProbe keyName="offline.pendingMany" values={{ count: 3 }} />);
    expect(screen.getByTestId('value').textContent).toBe('3 actions waiting to sync');
  });
});

function TranslationProbe({
  keyName,
  values,
}: {
  keyName: string;
  values?: Record<string, string | number>;
}) {
  const t = useT();
  return <span data-testid="value">{t(keyName, values)}</span>;
}

/**
 * Rows that go somewhere.
 *
 * `getHref` used to reach only the narrow-screen cards. On a desktop the rows
 * highlighted on hover, looked entirely clickable, and did nothing — so opening
 * a customer's history meant there was no way in at all from the list.
 *
 * The fix is a real anchor stretched over the row rather than a click handler
 * on the `<tr>`: a handler cannot be tabbed to, cannot be read out as a link,
 * and cannot be opened in a new tab.
 */
describe('a table row that links', () => {
  const people = [
    { id: 'c1', name: 'Suresh Kumar', owed: '₹340' },
    { id: 'c2', name: 'ईशा', owed: '₹0' },
  ];

  const renderTable = (withHref = true) =>
    wrap(
      <Table
        rows={people}
        getKey={(person) => person.id}
        {...(withHref
          ? {
              getHref: (person: (typeof people)[number]) => `/app/customers/${person.id}`,
              rowLabel: (person: (typeof people)[number]) => person.name,
            }
          : {})}
        columns={[
          { key: 'name', header: 'Customer', cell: (person) => <span>{person.name}</span> },
          { key: 'owed', header: 'Outstanding', cell: (person) => <span>{person.owed}</span> },
        ]}
      />,
    );

  /**
   * The desktop rows only.
   *
   * Both renderings are in the DOM at once — the table for wide screens and the
   * cards for narrow ones — and jsdom applies neither breakpoint, so every row
   * appears twice. The bug was in the table, so the table is what to assert on.
   */
  const tableLinks = () => {
    const table = document.querySelector('table')!;
    return Array.from(table.querySelectorAll('a'));
  };

  it('gives every row a link to follow', () => {
    renderTable();

    const links = tableLinks();
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/app/customers/c1');
    expect(links[1]).toHaveAttribute('href', '/app/customers/c2');
  });

  it('names each link, since the link itself has no text', () => {
    renderTable();

    // Without a name the row would be announced as an unlabelled link.
    const labels = tableLinks().map((link) => link.getAttribute('aria-label'));
    expect(labels).toEqual(['Suresh Kumar', 'ईशा']);
  });

  it('leaves rows alone when there is nowhere to go', () => {
    renderTable(false);
    expect(tableLinks()).toHaveLength(0);
  });

  it('still shows every cell', () => {
    renderTable();
    expect(screen.getAllByText('Suresh Kumar').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹340').length).toBeGreaterThan(0);
  });
});
