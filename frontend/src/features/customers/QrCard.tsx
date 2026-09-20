import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Download, ShieldCheck } from 'lucide-react';
import { Button, Skeleton } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { useTheme } from '@/app/providers/ThemeProvider';

/**
 * The customer's QR card.
 *
 * What the code contains is the point: `vyapio://c/<opaque token>` and nothing
 * else. No name, no phone number, no balance. Someone who photographs the card
 * learns nothing, and resolving the token requires an authenticated session at
 * the shop that issued it.
 *
 * The card is downloadable because the practical delivery mechanism is a
 * printed slip handed across the counter.
 */

type QrResponse = {
  qrId: string;
  payload: string;
  customerName: string;
};

export function QrCard({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const t = useT();
  const { resolved } = useTheme();
  const { data, loading } = useQuery<QrResponse>(`/customers/${customerId}/qr`);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.payload) return;

    void QRCode.toDataURL(data.payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color:
        // Rendered to match the active theme so it does not glare on a phone
        // held up in a dark shop.
        resolved === 'dark'
          ? { dark: '#F1EDF6', light: '#25212E' }
          : { dark: '#302B3B', light: '#FFFFFF' },
    }).then(setDataUrl, () => setDataUrl(null));
  }, [data?.payload, resolved]);

  const download = () => {
    if (!dataUrl) return;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `vyapio-${customerName.toLowerCase().replace(/\s+/g, '-')}.png`;
    link.click();
  };

  return (
    <div className="flex flex-col items-center pb-2">
      {loading || !dataUrl ? (
        <Skeleton className="size-56 rounded-[var(--radius-card)]" />
      ) : (
        <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
          <img
            src={dataUrl}
            alt={`Vyapio code for ${customerName}`}
            className="size-48"
            width={192}
            height={192}
          />
        </div>
      )}

      <p className="mt-4 text-center text-base font-bold text-[var(--color-ink)]">
        {customerName}
      </p>
      <p className="mt-1 max-w-xs text-center text-sm text-[var(--color-muted)]">
        {t('customers.qrHint')}
      </p>

      {/* States the privacy property explicitly, because a shopkeeper handing
          this over deserves to know what is on it. */}
      <p className="mt-4 flex items-start gap-2 rounded-[var(--radius-field)] bg-[var(--color-success-soft)] px-3 py-2.5 text-xs leading-snug text-[var(--color-success)]">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          This code holds only a random identifier — no name, number or balance. It is useless
          without a signed-in Vyapio account.
        </span>
      </p>

      <Button
        variant="outline"
        size="md"
        className="mt-4"
        onClick={download}
        disabled={!dataUrl}
        icon={<Download className="size-4" />}
      >
        Download card
      </Button>
    </div>
  );
}
