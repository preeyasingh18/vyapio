import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Microphone capture and in-browser speech recognition.
 *
 * Two things run in parallel and they are deliberately independent:
 *
 *   SpeechRecognition produces the transcript. Availability varies wildly —
 *   Chrome on Android is good, Firefox has nothing — so `supported` is checked
 *   before anything is promised to the user.
 *
 *   An AnalyserNode produces the waveform. It reads the *real* microphone
 *   signal, so the bars move because the shopkeeper is speaking, not because a
 *   timer is running. A faked waveform would be a small lie that undermines a
 *   feature whose whole job is to be trusted.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognition(): SpeechRecognitionConstructor | null {
  const globalWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return globalWindow.SpeechRecognition ?? globalWindow.webkitSpeechRecognition ?? null;
}

export type SpeechError = 'denied' | 'no-speech' | 'unsupported' | 'failed' | null;

export type SpeechState = {
  supported: boolean;
  listening: boolean;
  /** Text confirmed by the recogniser. */
  transcript: string;
  /** Text still being revised — shown greyed so the user sees it working. */
  interim: string;
  /** 0..1 amplitudes for the waveform. */
  levels: number[];
  error: SpeechError;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
};

export function useSpeech(language: string): SpeechState {
  const [supported] = useState(() => getRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState<SpeechError>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const frame = useRef<number>(0);
  /** Distinguishes a deliberate stop from the recogniser ending on its own. */
  const stopping = useRef(false);

  const teardownAudio = useCallback(() => {
    cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void audioContext.current?.close();
    audioContext.current = null;
    setLevels([]);
  }, []);

  /** Opens the mic and drives the waveform from real amplitude data. */
  const startMeter = useCallback(async () => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = media;

      const context = new AudioContext();
      audioContext.current = context;

      const source = context.createMediaStreamSource(media);
      const analyser = context.createAnalyser();
      // 64 bins is plenty for 28 bars and keeps the work per frame trivial.
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);

      const buffer = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(buffer);
        setLevels(Array.from(buffer, (value) => value / 255));
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    } catch {
      // The meter is cosmetic. Recognition may still work, so this is not
      // surfaced as an error.
      teardownAudio();
    }
  }, [teardownAudio]);

  const start = useCallback(async () => {
    const Recognition = getRecognition();
    if (!Recognition) {
      setError('unsupported');
      return;
    }

    setError(null);
    setTranscript('');
    setInterim('');
    stopping.current = false;

    await startMeter();

    const instance = new Recognition();
    instance.lang = language;
    // Continuous with interim results: a shopkeeper describing a sale pauses
    // mid-sentence, and stopping at the first silence would truncate them.
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else interimText += text;
      }

      if (finalText) setTranscript((current) => (current + ' ' + finalText).trim());
      setInterim(interimText);
    };

    instance.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('denied');
      } else if (event.error === 'no-speech') {
        setError('no-speech');
      } else if (event.error !== 'aborted') {
        setError('failed');
      }
      setListening(false);
      teardownAudio();
    };

    instance.onend = () => {
      setListening(false);
      teardownAudio();
    };

    recognition.current = instance;

    try {
      instance.start();
      setListening(true);
    } catch {
      setError('failed');
      teardownAudio();
    }
  }, [language, startMeter, teardownAudio]);

  const stop = useCallback(() => {
    stopping.current = true;
    recognition.current?.stop();
    setListening(false);
    teardownAudio();
  }, [teardownAudio]);

  const reset = useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
  }, []);

  // Never leave the microphone open behind a closed screen.
  useEffect(
    () => () => {
      recognition.current?.abort();
      teardownAudio();
    },
    [teardownAudio],
  );

  return { supported, listening, transcript, interim, levels, error, start, stop, reset };
}
