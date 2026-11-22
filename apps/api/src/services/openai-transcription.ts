import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25_000_000;
export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-transcribe';

const TRANSCRIPTION_LANGUAGES = ['en', 'hi', 'bn'];
const NATIVE_SCRIPT_PROMPT = [
  'This recording may switch between English, Hindi, and Bangla, including within a sentence.',
  'Transcribe the words as spoken. Preserve every language switch.',
  'Write English in Latin script, Hindi in Devanagari (हिन्दी), and Bangla in Bengali script (বাংলা).',
  'Do not translate between languages or transliterate the whole recording into one script.'
].join(' ');

export interface AudioTranscriptionInput {
  recordingId: string;
  mimeType: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}

export interface AudioTranscriptionResult {
  text: string;
  languageCodes: string[];
  model: typeof OPENAI_TRANSCRIPTION_MODEL;
}

export type TranscriptionFailureCode =
  | 'provider_not_configured'
  | 'unsupported_audio_format'
  | 'audio_too_large'
  | 'denoised_audio_duration_mismatch'
  | 'empty_audio'
  | 'provider_rejected_audio'
  | 'provider_unavailable'
  | 'transcription_failed';

export class AudioTranscriptionError extends Error {
  constructor(
    readonly code: TranscriptionFailureCode,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'AudioTranscriptionError';
  }
}

const supportedMimeExtensions: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/mpga': 'mpga',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm'
};

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function sanitizedRecordingName(recordingId: string, extension: string): string {
  const safeId = recordingId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'recording';
  return `${safeId}.${extension}`;
}

export interface AudioTranscriptionProvider {
  transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
}

/**
 * Calls OpenAI's file transcription API for text. The live worker supplies
 * clips produced from pyannote's Modal speaker timeline; this provider does
 * not request or return diarization, segment timings, or confidence values.
 */
export class OpenAIAudioTranscriptionProvider implements AudioTranscriptionProvider {
  private readonly client: OpenAI | undefined;

  constructor(options: { apiKey?: string; timeoutMs?: number } = {}) {
    const apiKey = options.apiKey?.trim() || Bun.env.OPENAI_API_KEY?.trim();
    if (apiKey) {
      this.client = new OpenAI({ apiKey, timeout: options.timeoutMs ?? 120_000 });
    }
  }

  async transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    if (!this.client) {
      throw new AudioTranscriptionError(
        'provider_not_configured',
        'OpenAI transcription is not configured on the API server.',
        true
      );
    }
    if (input.bytes.byteLength === 0) {
      throw new AudioTranscriptionError('empty_audio', 'The finalized recording contains no audio bytes.');
    }
    if (input.bytes.byteLength > OPENAI_TRANSCRIPTION_MAX_BYTES) {
      throw new AudioTranscriptionError(
        'audio_too_large',
        'This recording exceeds OpenAI’s 25 MB transcription file limit.'
      );
    }

    const mimeType = normalizeMimeType(input.mimeType);
    const extension = supportedMimeExtensions[mimeType];
    if (!extension) {
      throw new AudioTranscriptionError(
        'unsupported_audio_format',
        'The recording format is not supported by OpenAI transcription.'
      );
    }

    try {
      const file = await toFile(input.bytes, sanitizedRecordingName(input.recordingId, extension), { type: mimeType });
      const response = await this.client.audio.transcriptions.create({
        file,
        model: OPENAI_TRANSCRIPTION_MODEL,
        response_format: 'json',
        languages: TRANSCRIPTION_LANGUAGES,
        prompt: NATIVE_SCRIPT_PROMPT
      }, { signal: input.signal });
      return {
        text: response.text,
        languageCodes: response.languages?.map((language) => language.code).filter(Boolean) ?? [],
        model: OPENAI_TRANSCRIPTION_MODEL
      };
    } catch (error) {
      if (error instanceof AudioTranscriptionError) throw error;
      if (error instanceof OpenAI.APIError) {
        const status = error.status;
        const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
        throw new AudioTranscriptionError(
          status === 400 || status === 413 || status === 415 ? 'provider_rejected_audio' : 'provider_unavailable',
          status ? `OpenAI transcription returned HTTP ${status}.` : 'OpenAI transcription could not be reached.',
          retryable,
          status
        );
      }
      throw new AudioTranscriptionError(
        'transcription_failed',
        'The audio could not be transcribed. The recording remains stored and can be retried.',
        true
      );
    }
  }
}

export function readOpenAITranscriptionConfig(env: Record<string, string | undefined> = Bun.env): {
  configured: boolean;
  model: typeof OPENAI_TRANSCRIPTION_MODEL;
} {
  return { configured: Boolean(env.OPENAI_API_KEY?.trim()), model: OPENAI_TRANSCRIPTION_MODEL };
}
