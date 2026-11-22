import type { RecordingMetadata, RecordingTranscript } from '@itc/domain';
import type { RecordingRepository } from '../repositories/demo-repository';
import type { TranscriptionJobRepository } from '../repositories/mongo-transcription-repository';
import type { MongoConversationAnalysisRepository } from '../repositories/mongo-conversation-analysis-repository';
import {
  CONVERSATION_ANALYSIS_VERSION,
  ConversationAnalysisError,
  OpenAIConversationAnalyzer
} from './openai-conversation-analysis';

export type ConversationAnalysisRunResult =
  | { state: 'completed' }
  | { state: 'failed' }
  | { state: 'busy' }
  | { state: 'not_ready' };

export class ConversationAnalysisWorker {
  constructor(
    private readonly analyses: MongoConversationAnalysisRepository,
    private readonly recordings: RecordingRepository,
    private readonly transcripts: TranscriptionJobRepository,
    private readonly analyzer: OpenAIConversationAnalyzer
  ) {}

  async enqueue(recordingId: string) {
    const recording = await this.getEligibleRecording(recordingId);
    if (recording instanceof Error) throw recording;
    const transcript = await this.transcripts.get(recordingId);
    if (!transcript || transcript.state !== 'completed' || !transcript.turns?.length) {
      throw new Error('A completed diarized transcript is required before conversation analysis.');
    }
    if (!this.isBoundToCurrentAudio(recording, transcript)) throw new Error('The completed diarized transcript was produced from a different denoised analysis audio artifact.');
    const audio = recording.denoisedAnalysisAudio!;
    const analysis = await this.analyses.enqueue(recordingId, this.analyzer.model, CONVERSATION_ANALYSIS_VERSION, {
      objectKey: audio.objectKey!, sha256: audio.sha256!
    });
    await this.recordings.transitionConversationAnalysisState(recordingId, analysis.state);
    return analysis;
  }

  async retry(recordingId: string) {
    const recording = await this.getEligibleRecording(recordingId);
    if (recording instanceof Error) throw recording;
    const transcript = await this.transcripts.get(recordingId);
    if (!transcript || transcript.state !== 'completed' || !transcript.turns?.length) {
      throw new Error('A completed diarized transcript is required before conversation analysis.');
    }
    if (!this.isBoundToCurrentAudio(recording, transcript)) throw new Error('The completed diarized transcript was produced from a different denoised analysis audio artifact.');
    const analysis = await this.analyses.retry(recordingId);
    if (analysis) await this.recordings.transitionConversationAnalysisState(recordingId, 'queued');
    return analysis;
  }

  async reprocess(recordingId: string) {
    const recording = await this.getEligibleRecording(recordingId);
    if (recording instanceof Error) throw recording;
    const transcript = await this.transcripts.get(recordingId);
    if (!transcript || transcript.state !== 'completed' || !transcript.turns?.length) {
      throw new Error('A completed diarized transcript is required before conversation analysis.');
    }
    if (!this.isBoundToCurrentAudio(recording, transcript)) throw new Error('The completed diarized transcript was produced from a different denoised analysis audio artifact.');
    const audio = recording.denoisedAnalysisAudio!;
    const analysis = await this.analyses.reprocess(recordingId, this.analyzer.model, CONVERSATION_ANALYSIS_VERSION, {
      objectKey: audio.objectKey!, sha256: audio.sha256!
    });
    if (analysis) await this.recordings.transitionConversationAnalysisState(recordingId, 'queued');
    return analysis;
  }

  async runNext(recordingId?: string): Promise<ConversationAnalysisRunResult> {
    const job = await this.analyses.claimNext(recordingId);
    if (!job) {
      const existing = recordingId ? await this.analyses.get(recordingId) : undefined;
      return existing?.state === 'processing' ? { state: 'busy' } : { state: 'not_ready' };
    }
    const recording = await this.getEligibleRecording(job.recordingId);
    if (recording instanceof Error) return this.fail(job.recordingId, job.attempt, 'analysis_audio_unavailable', recording.message, false);
    const transcript = await this.transcripts.get(job.recordingId);
    if (!transcript || transcript.state !== 'completed' || !transcript.turns?.length) {
      return this.fail(job.recordingId, job.attempt, 'transcript_unavailable', 'A completed diarized transcript is required before conversation analysis.', false);
    }
    if (!this.isBoundToCurrentAudio(recording, transcript)) {
      return this.fail(job.recordingId, job.attempt, 'transcript_artifact_mismatch', 'The transcript was produced from a different denoised analysis audio artifact.', false);
    }
    if (job.analysisAudioObjectKey !== recording.denoisedAnalysisAudio?.objectKey
      || job.analysisAudioSha256 !== recording.denoisedAnalysisAudio?.sha256) {
      return this.fail(job.recordingId, job.attempt, 'analysis_artifact_mismatch', 'This analysis job is bound to a different denoised audio artifact.', false);
    }
    await this.recordings.transitionConversationAnalysisState(job.recordingId, 'processing');
    try {
      const content = await this.analyzer.analyze(transcript.turns);
      const completed = await this.analyses.saveCompleted(
        job.recordingId,
        job.attempt,
        content,
        this.analyzer.model,
        CONVERSATION_ANALYSIS_VERSION
      );
      if (!completed) return { state: 'not_ready' };
      await this.recordings.transitionConversationAnalysisState(job.recordingId, 'completed');
      return { state: 'completed' };
    } catch (error) {
      const normalized = error instanceof ConversationAnalysisError
        ? error
        : new ConversationAnalysisError('analysis_failed', 'Conversation analysis could not be completed.', true);
      return this.fail(job.recordingId, job.attempt, normalized.code, normalized.message, normalized.retryable);
    }
  }

  private async fail(recordingId: string, attempt: number, code: string, message: string, retryable: boolean): Promise<ConversationAnalysisRunResult> {
    const failed = await this.analyses.markFailed(recordingId, attempt, code, message, retryable);
    if (!failed) return { state: 'not_ready' };
    await this.recordings.transitionConversationAnalysisState(recordingId, 'failed');
    return { state: 'failed' };
  }

  private async getEligibleRecording(recordingId: string): Promise<RecordingMetadata | Error> {
    const recording = await this.recordings.getRecording(recordingId);
    const audio = recording?.denoisedAnalysisAudio;
    if (!recording || recording.syncState !== 'uploaded') return new Error('The original recording is not durably stored.');
    if (audio?.state !== 'ready' || audio.sampleRateHz !== 48_000 || audio.syncState !== 'uploaded'
      || !audio.objectKey || !audio.sha256 || !audio.durationSeconds) {
      return new Error('A denoised analysis audio artifact is required. Original audio is never sent to Pyannote.');
    }
    return recording;
  }

  private isBoundToCurrentAudio(
    recording: RecordingMetadata,
    transcript: NonNullable<Awaited<ReturnType<TranscriptionJobRepository['get']>>>
  ): boolean {
    const audio = recording.denoisedAnalysisAudio;
    return Boolean(audio?.objectKey && audio.sha256
      && transcript.analysisAudioObjectKey === audio.objectKey
      && transcript.analysisAudioSha256 === audio.sha256);
  }
}

export function transcriptFromJob(job: NonNullable<Awaited<ReturnType<TranscriptionJobRepository['get']>>>): RecordingTranscript {
  return {
    recordingId: job.recordingId,
    state: job.state,
    provider: 'openai',
    model: job.model,
    ...(job.transcriptText === undefined ? {} : { transcriptText: job.transcriptText }),
    ...(job.turns === undefined ? {} : { turns: job.turns }),
    ...(job.diarizer === undefined ? {} : { diarizer: job.diarizer }),
    ...(job.stage === undefined ? {} : { stage: job.stage }),
    languageCodes: job.languageCodes ?? [], attempts: job.attempts,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
    ...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
    ...(job.retryable === undefined ? {} : { retryable: job.retryable })
  };
}
