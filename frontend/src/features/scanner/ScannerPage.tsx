import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Camera, Keyboard, UserPlus, X } from 'lucide-react';
import { Button, Input, Sheet } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { api, ApiError } from '@/lib/api';
import type { Customer } from '@shared/entities';

/**
 * The scanner.
 *
 * Full-screen camera with a viewfinder, and two things it gets right that a
 * naive implementation would not:
 *
 *   The camera is released on every exit path — unmount, resolve, error. A
 *   PWA that leaves the torch on behind a modal is a bug a shopkeeper notices
 *   within a day.
 *
 *   Every failure mode has a way forward. Permission denied, no camera, a
 *   damaged code — all of them land on "enter the phone number instead" rather
 *   than a dead end.
 */

type ResolveResponse = {
  found: boolean;
  customer?: Customer;
  greeting: string;
  qrId?: string;
  phone?: string;
};

type Mode = 'scanning' | 'denied' | 'unavailable' | 'resolving';

export default function ScannerPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Set once a code resolves, so the decode loop stops firing. */
  const handled = useRef(false);

  const [mode, setMode] = useState<Mode>('scanning');
  const [manualOpen, setManualOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<{ qrId?: string; phone?: string } | null>(null);
  const [newName, setNewName] = useState('');

  /** Releases the camera. Safe to call repeatedly. */
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const resolve = useCallback(
    async (payload: { qrId?: string; phone?: string }) => {
      if (handled.current) return;
      handled.current = true;

      setMode('resolving');
      stopCamera();

      try {
        const result = await api.post<ResolveResponse>('/customers/resolve', payload);

        if (result.found && result.customer) {
          toast.success(result.greeting, result.customer.name);
          navigate(`/app/customers/${result.customer.customerId}`, { replace: true });
          return;
        }

        // Not found: offer to create, carrying the scanned token so the card
        // the customer already holds keeps working.
        setUnknown({
          ...(result.qrId ? { qrId: result.qrId } : {}),
          ...(result.phone ? { phone: result.phone } : {}),
        });
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
        handled.current = false;
        setMode('scanning');
      }
    },
    [navigate, stopCamera, toast, t],
  );

  /* ── Camera and decoding ───────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    let controls: { stop: () => void } | null = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMode('unavailable');
        return;
      }

      try {
        // The decoder is a large dependency; loading it here keeps it out of
        // every other screen's bundle.
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        if (cancelled) return;

        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: 180,
        });

        controls = await reader.decodeFromVideoDevice(
          // `undefined` lets the browser choose, which picks the rear camera
          // on a phone.
          undefined,
          videoRef.current!,
          (result) => {
            if (!result || handled.current) return;
            void resolve({ qrId: result.getText() });
          },
        );

        streamRef.current = (videoRef.current?.srcObject as MediaStream | null) ?? null;
      } catch (error) {
        if (cancelled) return;

        const name = error instanceof Error ? error.name : '';
        setMode(
          name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable',
        );
      }
    }

    void start();

    return () => {
      cancelled = true;
      controls?.stop();
      stopCamera();
    };
  }, [resolve, stopCamera]);

  // Belt and braces: release the camera if the tab is backgrounded.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') stopCamera();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [stopCamera]);

  /* ── Actions ───────────────────────────────────────────────────────────── */

  /**
   * What is still wrong with the number, in the shopkeeper's words.
   *
   * The same two rules the server enforces: ten digits, starting 6-9. Saying
   * so here means a wrong number is caught at the keypad rather than coming
   * back as "no customer found", which reads as the customer being missing
   * rather than the number being mistyped.
   */
  const phoneProblem =
    phone.length === 0
      ? null
      : phone.length < 10
        ? t('scanner.phoneRemaining', { count: 10 - phone.length })
        : /^[6-9]/.test(phone)
          ? null
          : t('scanner.phoneStart');

  const phoneReady = phone.length === 10 && /^[6-9]/.test(phone);

  const lookUpPhone = async () => {
    const digits = phone.replace(/\D/g, '');
    if (!phoneReady) return;
    setManualOpen(false);
    handled.current = false;
    await resolve({ phone: digits });
  };

  const createCustomer = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const result = await api.post<{ customer: Customer; message: string }>('/customers', {
        name: newName.trim(),
        phone: unknown?.phone ?? '',
        ...(unknown?.qrId ? { qrId: unknown.qrId } : {}),
      });
      toast.success(t('scanner.memoryCreated'), result.customer.name);
      navigate(`/app/customers/${result.customer.customerId}`, { replace: true });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Camera feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 size-full object-cover"
        playsInline
        muted
        aria-hidden="true"
      />

      {/* Dim everything except the viewfinder. */}
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />

      <header className="relative flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-4">
        <h1 className="text-base font-bold text-white">{t('scanner.title')}</h1>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-[var(--radius-field)] bg-white/15 p-2 text-white backdrop-blur-sm transition-colors active:bg-white/25"
          aria-label={t('common.close')}
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </header>

      <div className="relative flex flex-1 flex-col items-center justify-center px-6">
        {mode === 'scanning' ? (
          <>
            {/* Viewfinder: corner brackets plus a travelling scan line. */}
            <div className="relative aspect-square w-full max-w-[280px]">
              <div className="absolute inset-0 rounded-[2rem] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />

              {(
                [
                  'top-0 left-0 border-t-4 border-l-4 rounded-tl-[2rem]',
                  'top-0 right-0 border-t-4 border-r-4 rounded-tr-[2rem]',
                  'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-[2rem]',
                  'bottom-0 right-0 border-b-4 border-r-4 rounded-br-[2rem]',
                ] as const
              ).map((corner) => (
                <span
                  key={corner}
                  className={`absolute size-12 border-[var(--color-accent)] ${corner}`}
                  aria-hidden="true"
                />
              ))}

              <span
                className="scanline absolute inset-x-6 top-1/2 h-0.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_12px_var(--color-accent)]"
                aria-hidden="true"
              />
            </div>

            <p className="mt-8 text-center text-sm text-white/80">{t('scanner.hint')}</p>
          </>
        ) : mode === 'resolving' ? (
          <div className="flex flex-col items-center gap-4">
            <LogoMark size={96} tone="light" pulse label={t('common.loading')} />
            <p className="text-sm text-white/80">{t('common.loading')}</p>
          </div>
        ) : (
          <div className="flex max-w-sm flex-col items-center text-center">
            <Camera className="size-12 text-white/60" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-bold text-white">
              {mode === 'denied' ? t('scanner.cameraDenied') : t('scanner.cameraUnavailable')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              {mode === 'denied' ? t('scanner.cameraDeniedBody') : t('scanner.cameraUnavailableBody')}
            </p>
          </div>
        )}
      </div>

      {/* Phone fallback is always available, never only after a failure. */}
      <footer className="relative px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <Button
          variant="outline"
          size="lg"
          block
          onClick={() => setManualOpen(true)}
          icon={<Keyboard className="size-4" />}
          className="border-white/25 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20"
        >
          {t('scanner.enterPhone')}
        </Button>
      </footer>

      {/* ── Phone lookup ──────────────────────────────────────────────────── */}
      <Sheet
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title={t('scanner.enterPhone')}
        footer={
          <Button
            size="lg"
            block
            onClick={() => void lookUpPhone()}
            disabled={!phoneReady}
          >
            {t('scanner.lookUp')}
          </Button>
        }
      >
        {/*
          Says what is missing while it is missing.
          A disabled button with nothing beside it leaves the shopkeeper
          guessing at which of the number, the length or the shop is wrong —
          and they are usually mid-queue when they find out.
        */}
        <Input
          type="tel"
          inputMode="numeric"
          autoFocus
          prefix="+91"
          placeholder={t('scanner.phonePlaceholder')}
          value={phone}
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
          hint={phoneProblem ?? undefined}
        />
      </Sheet>

      {/* ── Unknown customer ──────────────────────────────────────────────── */}
      <Sheet
        open={unknown !== null}
        onClose={() => {
          setUnknown(null);
          handled.current = false;
          setMode('scanning');
        }}
        title={t('scanner.notFound')}
        footer={
          <Button
            size="lg"
            block
            loading={busy}
            disabled={!newName.trim()}
            onClick={() => void createCustomer()}
            icon={<UserPlus className="size-4" />}
          >
            {t('scanner.createCustomer')}
          </Button>
        }
      >
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center pb-2"
          >
            <LogoMark size={56} />
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              {unknown?.phone
                ? `No one saved with ${unknown.phone}.`
                : 'This code is not linked to anyone yet.'}
            </p>
          </motion.div>
        </AnimatePresence>

        <div className="mt-4">
          <Input
            label={t('auth.name')}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Ramesh Kumar"
            autoFocus
          />
          {unknown?.phone ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Phone: <span className="font-medium text-[var(--color-ink)]">{unknown.phone}</span>
            </p>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
