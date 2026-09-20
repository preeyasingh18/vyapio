import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
} from '@aws-sdk/client-transcribe-streaming';
import { config } from '../config/index';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { languageMeta, type Language } from '../schemas/common';

/**
 * Speech to text.
 *
 * Two capture paths, and the UI always names the one in use:
 *
 *   Transcribe Streaming — TRANSCRIBE_ENABLED=true. Audio is streamed from the
 *     browser to this Lambda over a WebSocket-style POST and on to Amazon
 *     Transcribe. Best accuracy on Indian languages and code-switched speech.
 *
 *   Web Speech API — the default. Recognition runs in the browser. Free and
 *     instant, but availability varies by browser and language support for
 *     Indian languages is uneven.
 *
 * `capabilities()` is what the client reads to decide, so voice is never
 * silently downgraded without the shopkeeper being told which engine ran.
 */

let client: TranscribeStreamingClient | null = null;

function transcribe(): TranscribeStreamingClient {
  client ??= new TranscribeStreamingClient({ region: config.transcribe.region });
  return client;
}

export function isTranscribeEnabled(): boolean {
  return config.transcribe.mode === 'aws';
}

export type TranscribeCapabilities = {
  engine: 'aws-transcribe' | 'browser-speech';
  /** Transcribe language code, e.g. 'hi-IN'. */
  languageCode: string;
  /** BCP-47 tag for the browser's SpeechRecognition. */
  bcp47: string;
  sampleRate: number;
  /** Shown verbatim in the voice UI. */
  note: string;
};

export function capabilities(language: Language): TranscribeCapabilities {
  const meta = languageMeta(language);
  if (isTranscribeEnabled()) {
    return {
      engine: 'aws-transcribe',
      languageCode: meta.transcribe,
      bcp47: meta.bcp47,
      sampleRate: 16_000,
      note: `Listening with Amazon Transcribe in ${meta.label}.`,
    };
  }
  return {
    engine: 'browser-speech',
    languageCode: meta.transcribe,
    bcp47: meta.bcp47,
    sampleRate: 16_000,
    note: `Listening with your browser's speech recognition in ${meta.label}. Enable Amazon Transcribe for better accuracy on Indian languages.`,
  };
}

export type TranscriptChunk = {
  text: string;
  /** False while Transcribe is still revising the phrase. */
  isFinal: boolean;
};

/**
 * Streams PCM audio to Transcribe and yields transcript chunks.
 *
 * Audio arrives as 16 kHz mono 16-bit little-endian PCM, which is what the
 * browser's AudioWorklet produces after downsampling — no server-side
 * transcoding, so latency stays low enough to feel live.
 */
export async function* streamTranscription(input: {
  audio: AsyncIterable<Uint8Array>;
  language: Language;
  vendorId: string;
}): AsyncGenerator<TranscriptChunk> {
  if (!isTranscribeEnabled()) {
    throw new AppError('NOT_CONFIGURED', 'Amazon Transcribe is not enabled', {
      userMessage: 'Streaming transcription is not configured. Use in-browser voice instead.',
    });
  }

  const meta = languageMeta(input.language);
  const startedAt = Date.now();

  async function* audioStream(): AsyncGenerator<AudioStream> {
    for await (const chunk of input.audio) {
      yield { AudioEvent: { AudioChunk: chunk } };
    }
  }

  try {
    const response = await transcribe().send(
      new StartStreamTranscriptionCommand({
        LanguageCode: meta.transcribe,
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: 16_000,
        AudioStream: audioStream(),
        // Partial-results stabilisation stops the caption from rewriting itself
        // distractingly while the shopkeeper is still speaking.
        EnablePartialResultsStabilization: true,
        PartialResultsStability: 'medium',
      }),
    );

    if (!response.TranscriptResultStream) {
      throw new AppError('TRANSCRIBE_UNAVAILABLE', 'Transcribe returned no result stream');
    }

    for await (const event of response.TranscriptResultStream) {
      const results = event.TranscriptEvent?.Transcript?.Results ?? [];
      for (const result of results) {
        const text = result.Alternatives?.[0]?.Transcript ?? '';
        if (!text) continue;
        yield { text, isFinal: result.IsPartial !== true };
      }
    }

    logger.info('transcription stream closed', {
      operation: 'transcribe.stream',
      vendorId: input.vendorId,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error('transcription failed', {
      operation: 'transcribe.stream',
      vendorId: input.vendorId,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw new AppError('TRANSCRIBE_UNAVAILABLE', String(error), { cause: error });
  }
}

/** Test seam. */
export function setTranscribeClient(next: TranscribeStreamingClient | null): void {
  client = next;
}
