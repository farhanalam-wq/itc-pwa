import type { RecordingMetadata } from '@itc/domain';
import type { RecordingRepository } from '../repositories/demo-repository';
import type { TranscriptionJob, TranscriptionJobRepository } from '../repositories/mongo-transcription-repository';
import {
  AudioTranscriptionError,
  OPENAI_TRANSCRIPTION_MODEL,
  type AudioTranscriptionProvider
} from './openai-transcription';
import type { DiarizedTranscriptionPipeline } from './diarized-transcription';
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
    private readonly provider: AudioTranscriptionProvider,
    private readonly diarized: DiarizedTranscriptionPipeline
  ) {}

  async enqueue(recordingId: string): Promise<TranscriptionJob> {
    const recording = await this.recordings.getRecording(recordingId);
    const audio = recording?.denoisedAnalysisAudio;
    if (!recording || recording.syncState !== 'uploaded' || !recording.objectKey
      || audio?.state !== 'ready' || audio.sampleRateHz !== 48_000 || audio.syncState !== 'uploaded'
      || !audio.objectKey || !audio.sha256 || !audio.mimeType || !audio.durationSeconds) {
      throw new Error('Only a durably uploaded recording with a denoised analysis audio artifact can be queued for transcription.');
    }
    const artifact = { objectKey: audio.objectKey, sha256: audio.sha256 };
    const job = await this.jobs.enqueue(recordingId, OPENAI_TRANSCRIPTION_MODEL, 'diarized', artifact);
    // A deletion may finish while a transcript request is queueing work.
    const latest = await this.recordings.getRecording(recordingId);
    if (!latest) {
      await this.jobs.delete(recordingId);
      throw new Error('The recording was deleted before transcription could be queued.');
    }
    if (latest.denoisedAnalysisAudio?.objectKey !== artifact.objectKey || latest.denoisedAnalysisAudio.sha256 !== artifact.sha256) {
      throw new Error('The denoised analysis audio changed before transcription could be queued.');
    }
    return job;
  }

  async runNext(recordingId?: string): Promise<TranscriptionRunResult> {
    const job = await this.jobs.claimNext(recordingId);
    if (!job) {
      const existing = recordingId ? await this.jobs.get(recordingId) : undefined;
      if (existing?.state === 'processing') return { state: 'busy', job: existing };
      return { state: 'not_ready', job: existing };
    }

    const controller = new AbortController();
    const renew = async (
      update: Parameters<TranscriptionJobRepository['checkpoint']>[2] = {}
    ) => {
      controller.signal.throwIfAborted();
      if (!await this.jobs.checkpoint(job.recordingId, job.attempts, update)) {
        controller.abort(new Error('The transcription lease was lost.'));
        controller.signal.throwIfAborted();
      }
    };
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renew().catch(() => controller.abort(new Error('Could not renew the transcription lease.')))
        .finally(() => { renewing = false; });
    }, 30_000);

    try {
      const recording = await this.recordings.getRecording(job.recordingId);
      if (!this.isStored(recording) || !this.isDenoisedStored(recording)
        || job.analysisAudioObjectKey !== recording.denoisedAnalysisAudio.objectKey
        || job.analysisAudioSha256 !== recording.denoisedAnalysisAudio.sha256) {
        const failed = await this.jobs.markFailed({
          recordingId: job.recordingId,
          attempt: job.attempts,
          errorCode: 'denoised_audio_unavailable',
          errorMessage: 'The bound denoised analysis audio is unavailable or has changed. Pyannote did not receive the original recording.',
          retryable: false
        });
        if (!failed) return { state: 'not_ready' };
        await this.recordings.transitionAnalysisState(job.recordingId, 'error');
        return { state: 'failed', job: failed };
      }

      if (recording.analysisState === 'not_started' || recording.analysisState === 'error' || recording.analysisState === 'ready') {
        await this.recordings.transitionAnalysisState(recording.id, 'transcribing');
      }
      const analysisAudio = recording.denoisedAnalysisAudio;
      const bytes = await this.storage.readFinal(analysisAudio.objectKey, recording.storageDriver);
      await renew();
      // All jobs, including legacy jobs without a stored mode, must obtain their
      // speaker timeline from pyannote through Modal before OpenAI transcribes clips.
      const result = await this.diarized.transcribe({
        job, bytes, mimeType: analysisAudio.mimeType ?? recording.mimeType, expectedDurationSeconds: analysisAudio.durationSeconds, provider: this.provider, signal: controller.signal,
        checkpoint: (stage, diarization) => renew({stage, diarization})
      });
      controller.signal.throwIfAborted();
      const completed = await this.jobs.markCompleted({
        recordingId: recording.id,
        attempt: job.attempts,
        transcriptText: result.text,
        turns: result.turns,
        diarizer: result.diarizer,
        languageCodes: result.languageCodes,
        model: result.model
      });
      if (!completed) return { state: 'not_ready' };
      await this.recordings.transitionAnalysisState(recording.id, 'ready');
      return { state: 'completed', job: completed };
    } catch (error) {
      if (controller.signal.aborted) return { state: 'not_ready' };
      const normalized = error instanceof AudioTranscriptionError
        ? error
        : new AudioTranscriptionError(
          'transcription_failed',
          'Transcription could not be completed. The stored recording remains available for retry.',
          true
        );
      const failed = await this.jobs.markFailed({
        recordingId: job.recordingId,
        attempt: job.attempts,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        retryable: normalized.retryable
      });
      if (!failed) return { state: 'not_ready' };
      await this.recordings.transitionAnalysisState(job.recordingId, 'error');
      return { state: 'failed', job: failed };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private isStored(recording: RecordingMetadata | undefined): recording is RecordingMetadata & { objectKey: string } {
    return Boolean(recording && recording.syncState === 'uploaded' && recording.objectKey);
  }

  private isDenoisedStored(recording: RecordingMetadata): recording is RecordingMetadata & {
    denoisedAnalysisAudio: NonNullable<RecordingMetadata['denoisedAnalysisAudio']> & { objectKey: string; sha256: string; durationSeconds: number }
  } {
    const audio = recording.denoisedAnalysisAudio;
    return Boolean(audio && audio.state === 'ready' && audio.sampleRateHz === 48_000
      && audio.syncState === 'uploaded' && audio.objectKey && audio.sha256 && audio.durationSeconds);
  }
}
