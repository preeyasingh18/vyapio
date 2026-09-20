import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Input } from '@/components/ui';

/**
 * Fields with an adornment.
 *
 * The bug these pin down: the prefix was positioned over the field and the
 * field reserved a fixed 36px for it. That fits "₹" and nothing else, so a
 * phone field showing "+91" had the typed number start underneath the prefix —
 * "+91" and "912" ran together into one unreadable string. The same reserve on
 * the right did it to units like "packet".
 *
 * Laying the affixes out beside the input is what makes the box fit whatever it
 * is given, so these assert on the structure rather than on a pixel width: the
 * input must be a sibling of the affix, not a layer under it.
 */

describe('an input with an affix', () => {
  const field = () => screen.getByRole('textbox') as HTMLInputElement;

  it('puts the prefix beside the input, not over it', () => {
    render(<Input prefix="+91" defaultValue="9876543210" />);

    const input = field();
    const box = input.parentElement!;

    // Same row, so the box grows to fit the affix.
    expect(box).toHaveTextContent('+91');
    expect(box.className).toContain('flex');
    // Nothing absolutely positioned, and no fixed reserve to keep in step.
    expect(box.innerHTML).not.toContain('absolute');
    expect(input.className).not.toContain('pl-9');
  });

  it('does the same for a suffix of any length', () => {
    render(<Input suffix="packet" defaultValue="12" />);

    const box = field().parentElement!;
    expect(box).toHaveTextContent('packet');
    expect(box.innerHTML).not.toContain('absolute');
  });

  it('leaves a plain field as a single element', () => {
    // Callers style the box through `className`; with no affix that is still
    // the input itself, so nothing they pass lands on a wrapper instead.
    render(<Input className="w-16 text-center" defaultValue="5" />);

    expect(field().className).toContain('w-16');
    expect(field().className).toContain('text-center');
  });

  it('carries the caller’s sizing onto the box when there is an affix', () => {
    render(<Input prefix="₹" className="w-24" defaultValue="60" />);

    expect(field().parentElement!.className).toContain('w-24');
  });
});

describe('typing into a phone field', () => {
  /** Mirrors how the scanner and customer forms hold the value. */
  function PhoneField() {
    const [phone, setPhone] = useState('');
    return (
      <>
        <Input
          prefix="+91"
          value={phone}
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
        />
        <output>{phone}</output>
      </>
    );
  }

  it('keeps ten digits, and only digits', () => {
    render(<PhoneField />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '9876543210' } });
    expect(screen.getByRole('status')).toHaveTextContent('9876543210');
    expect(input.value).toBe('9876543210');
  });

  it('drops a pasted country code rather than storing it twice', () => {
    render(<PhoneField />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    // The field already shows +91; a pasted number carrying its own must not
    // end up as +91 +91 9876543210 once the two are joined.
    fireEvent.change(input, { target: { value: '+91 98765 43210' } });
    expect(input.value).toBe('9198765432');
  });

  it('shows the hint it is given', () => {
    render(<Input prefix="+91" hint="2 more digits to go" defaultValue="98765432" />);
    expect(screen.getByText('2 more digits to go')).toBeInTheDocument();
  });
});

describe('an invalid field', () => {
  it('marks itself invalid and shows the message, affix or not', () => {
    const { rerender } = render(<Input prefix="+91" error="Enter a valid number" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid number');

    rerender(<Input error="Enter a valid number" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid number');
  });
});

describe('the field stays usable', () => {
  it('passes typing through to the caller when an affix is present', () => {
    const onChange = vi.fn();
    render(<Input prefix="₹" onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '250' } });
    expect(onChange).toHaveBeenCalled();
  });
});
