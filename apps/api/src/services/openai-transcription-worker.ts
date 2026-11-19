import type { RecordingMetadata } from '@itc/domain';
import type { RecordingRepository } from '../repositories/demo-repository';
import type { TranscriptionJob, TranscriptionJobRepository } from '../repositories/mongo-transcription-repository';
import {
  AudioTranscriptionError,
  OPENAI_TRANSCRIPTION_MAX_BYTES,
  OPENAI_TRANSCRIPTION_MODEL,
  type AudioTranscriptionProvider
} from './openai-transcription';
import type { RecordingObjectStorage } from './storage/recording-storage';

export type TranscriptionRunResult =
  | { state: 'completed'; job: TranscriptionJob }
  | { state: 'failed'; job: TranscriptionJob }
  | { state: 'busy'; job: TranscriptionJob }
  | { state: 'not_ready'; job?: TranscriptionJob };

/**
 * Coordinates durable queue state, configured audio storage, and the provider.
 * Call `runNext` at startup and after queueing a completed recording. A stale
 * processing lease is reclaimable after a process restart.
 */
export class OpenAITranscriptionWorker {
  constructor(
    private readonly jobs: TranscriptionJobRepository,
    private readonly recordings: RecordingRepository,
    private readonly storage: RecordingObjectStorage,
    private readonly provider: AudioTranscriptionProvider
  ) {}

  async enqueue(recordingId: string): Promise<TranscriptionJob> {
    const recording = await this.recordings.getRecording(recordingId);
    if (!recording || recording.syncState !== 'uploaded' || !recording.objectKey) {
      throw new Error('Only a durably uploaded recording can be queued for transcription.');
    }
    return this.jobs.enqueue(recordingId, OPENAI_TRANSCRIPTION_MODEL);
  }

  async runNext(recordingId?: string): Promise<TranscriptionRunResult> {
    const job = await this.jobs.claimNext(recordingId);
    if (!job) {
      const existing = recordingId ? await this.jobs.get(recordingId) : undefined;
      if (existing?.state === 'processing') return { state: 'busy', job: existing };
      return { state: 'not_ready', job: existing };
    }

    try {
      const recording = await this.recordings.getRecording(job.recordingId);
      if (!this.isStored(recording)) {
        const failed = await this.jobs.markFailed({
          recordingId: job.recordingId,
          errorCode: 'recording_not_stored',
          errorMessage: 'The recording is not available in configured storage.',
          retryable: true
        });
        if (!failed) throw new Error('Could not persist the transcription failure state.');
        await this.recordings.transitionAnalysisState(job.recordingId, 'error');
        return { state: 'failed', job: failed };
      }

      if (recording.analysisState === 'not_started' || recording.analysisState === 'error') {
        await this.recordings.transitionAnalysisState(recording.id, 'transcribing');
      }
      if (recording.byteLength > OPENAI_TRANSCRIPTION_MAX_BYTES) {
        const failed = await this.jobs.markFailed({
          recordingId: job.recordingId,
          errorCode: 'audio_too_large',
          errorMessage: 'This recording exceeds OpenAI’s 25 MiB transcription file limit.',
          retryable: false
        });
        if (!failed) throw new Error('Could not persist the transcription failure state.');
        return { state: 'failed', job: failed };
      }

      const bytes = await this.storage.readFinal(recording.objectKey);
      const result = await this.provider.transcribe({
        recordingId: recording.id,
        mimeType: recording.mimeType,
        bytes
      });
      const completed = await this.jobs.markCompleted({
        recordingId: recording.id,
        transcriptText: result.text,
        languageCodes: result.languageCodes,
        model: result.model
      });
      if (!completed) throw new Error('Could not persist the transcription result.');
      await this.recordings.transitionAnalysisState(recording.id, 'ready');
      return { state: 'completed', job: completed };
    } catch (error) {
      const normalized = error instanceof AudioTranscriptionError
        ? error
        : new AudioTranscriptionError(
          'transcription_failed',
          'Transcription could not be completed. The stored recording remains available for retry.',
          true
        );
      const failed = await this.jobs.markFailed({
        recordingId: job.recordingId,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        retryable: normalized.retryable
      });
      if (!failed) throw new Error('Could not persist the transcription failure state.');
      await this.recordings.transitionAnalysisState(job.recordingId, 'error');
      return { state: 'failed', job: failed };
    }
  }

  private isStored(recording: RecordingMetadata | undefined): recording is RecordingMetadata & { objectKey: string } {
    return Boolean(recording && recording.syncState === 'uploaded' && recording.objectKey);
  }
}
