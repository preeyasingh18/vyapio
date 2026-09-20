import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { Sheet, Input, Button } from '@/components/ui';

/**
 * Typing inside a sheet.
 *
 * The bug these pin down made every form in the app unusable with a keyboard:
 * the open/close effect had `onClose` in its dependency array, and every caller
 * passes an inline arrow, so the effect tore down and re-ran on every single
 * keystroke. Its cleanup restores focus to whatever was focused before the
 * sheet opened — so each character typed threw focus out of the field, and the
 * person had to click back in before the next one.
 *
 * The test therefore types several characters in a row and asserts the caret
 * never left. Typing one character would not have caught it.
 */

/** A sheet holding a field, wired exactly as the app wires them. */
function PhoneSheet({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  const [phone, setPhone] = useState('');

  return (
    <Sheet
      open={open}
      // Inline, on purpose: this is what every call site does, and what the
      // component has to tolerate.
      onClose={() => {
        setOpen(false);
        onClose();
      }}
      title="Enter phone number instead"
      footer={<Button disabled={phone.length !== 10}>Look up</Button>}
    >
      <Input
        autoFocus
        prefix="+91"
        aria-label="Phone number"
        value={phone}
        onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
      />
    </Sheet>
  );
}

/** Lets the sheet's queued focus timer run, as it would in a browser. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(80);
  });
}

describe('a field inside a sheet', () => {
  it('keeps focus across a whole phone number', async () => {
    vi.useFakeTimers();
    try {
      render(<PhoneSheet />);
      const input = screen.getByLabelText('Phone number') as HTMLInputElement;

      input.focus();
      await settle();

      // One digit at a time, as a person types it.
      for (const digit of '9876543210') {
        fireEvent.change(input, { target: { value: input.value + digit } });
        await settle();
        expect(document.activeElement).toBe(input);
      }

      expect(input.value).toBe('9876543210');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an autofocused field focused instead of grabbing focus back', async () => {
    vi.useFakeTimers();
    try {
      render(<PhoneSheet />);
      const input = screen.getByLabelText('Phone number');

      // The panel focuses itself shortly after opening; a field that asked for
      // focus must keep it.
      await settle();
      expect(document.activeElement).toBe(input);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still closes on Escape, with the latest handler', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    try {
      render(<PhoneSheet onClose={onClose} />);
      const input = screen.getByLabelText('Phone number') as HTMLInputElement;

      // Type first, so the handler the listener calls is a later one than the
      // handler that was current when the sheet opened.
      fireEvent.change(input, { target: { value: '98' } });
      await settle();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
