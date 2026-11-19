import { Elysia, t } from 'elysia';
import type { AnalysisState, ManualTranscriptAnalysis, RecordingMetadata, SyncState } from '@itc/domain';
import {
  DemoRecordingRepository,
  type RecordingRepository
} from './repositories/demo-repository';
import {
  InMemoryManualTranscriptRepository,
  type ManualTranscriptRepository
} from './repositories/manual-transcript-repository';
import { analyzeManualTranscript } from './services/manual-transcript-analysis';
import { LocalRecordingStorage } from './services/local-recording-storage';
import { createRecordingStorage, type RecordingObjectStorage } from './services/storage/recording-storage';
import { readStorageConfig } from './services/storage/config';
import {
  S3RecordingUploads
} from './services/s3-recording-uploads';

const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

const syncStateSchema = t.Union([
  t.Literal('queued'),
  t.Literal('uploading'),
  t.Literal('uploaded'),
  t.Literal('error')
]);

const analysisStateSchema = t.Union([
  t.Literal('not_started'),
  t.Literal('transcribing'),
  t.Literal('analyzing'),
  t.Literal('ready'),
  t.Literal('error')
]);

const errorSchema = t.Object({
  code: t.String(),
  message: t.String()
});

const visitSchema = t.Object({
  id: t.String(),
  outletName: t.String(),
  representativeId: t.String(),
  territoryId: t.String(),
  consentRecordedAt: t.String(),
  createdAt: t.String(),
  recordingIds: t.Array(t.String())
});

const recordingSchema = t.Object({
  id: t.String(),
  outletId: t.Optional(t.String()),
  outletName: t.String(),
  representativeId: t.String(),
  territoryId: t.String(),
  startedAt: t.String(),
  durationSeconds: t.Number(),
  mimeType: t.String(),
  byteLength: t.Number(),
  objectKey: t.Optional(t.String()),
  storageDriver: t.Optional(t.Union([t.Literal('local'), t.Literal('s3')])),
  sha256: t.Optional(t.String()),
  syncState: syncStateSchema,
  analysisState: analysisStateSchema
});

const recordingPageSchema = t.Object({
  recordings: t.Array(recordingSchema),
  total: t.Number(),
  nextOffset: t.Nullable(t.Number())
});

const analysisStatusSchema = t.Object({
  id: t.String(),
  syncState: syncStateSchema,
  analysisState: analysisStateSchema
});

const createVisitBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 128 }),
  outletName: t.String({ minLength: 1, maxLength: 200 }),
  representativeId: t.String({ minLength: 1, maxLength: 128 }),
  territoryId: t.String({ minLength: 1, maxLength: 128 }),
  consentRecordedAt: t.String({ format: 'date-time' })
});

const createRecordingBody = t.Object({
  id: t.String({ minLength: 1, maxLength: 128 }),
  startedAt: t.String({ format: 'date-time' }),
  durationSeconds: t.Number({ minimum: 0, maximum: 60 * 60 * 8 }),
  mimeType: t.String({ minLength: 1, maxLength: 128 }),
  byteLength: t.Number({ minimum: 1, maximum: MAX_RECORDING_BYTES })
});

const recordingParams = t.Object({ recordingId: t.String({ minLength: 1, maxLength: 128 }) });
const recordingChunkParams = t.Object({ recordingId: t.String({ minLength: 1, maxLength: 128 }), chunkIndex: t.Numeric({ minimum: 0 }), chunkCount: t.Numeric({ minimum: 1 }) });
const visitParams = t.Object({ visitId: t.String({ minLength: 1, maxLength: 128 }) });

const recordingQuery = t.Object({
  syncState: t.Optional(syncStateSchema),
  analysisState: t.Optional(analysisStateSchema),
  representativeId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  territoryId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  offset: t.Optional(t.Numeric({ minimum: 0, maximum: 100000 }))
});

const uploadUnavailableSchema = t.Object({ code: t.String(), message: t.String() });
const signedUrlSchema = t.Object({
  url: t.String({ format: 'uri' }),
  objectKey: t.String(),
  expiresAt: t.String({ format: 'date-time' })
});

const transcriptSegmentSchema = t.Object({
  id: t.String(),
  speaker: t.Union([t.Literal('representative'), t.Literal('shopkeeper'), t.Literal('unknown')]),
  startMs: t.Optional(t.Number()),
  endMs: t.Optional(t.Number()),
  text: t.String(),
  confidence: t.Optional(t.Number())
});

const transcriptInsightSchema = t.Object({
  id: t.String(),
  category: t.Union([
    t.Literal('demand'), t.Literal('objection'), t.Literal('availability'), t.Literal('competitor'),
    t.Literal('sentiment'), t.Literal('commitment'), t.Literal('conversation_quality')
  ]),
  title: t.String(),
  summary: t.String(),
  confidence: t.Union([t.Literal('high'), t.Literal('medium'), t.Literal('low')]),
  evidence: t.Array(t.Object({
    segmentIds: t.Array(t.String()),
    quote: t.String(),
    startMs: t.Optional(t.Number()),
    endMs: t.Optional(t.Number())
  })),
  suggestedAction: t.Optional(t.String()),
  reviewedAt: t.Optional(t.String()),
  reviewedBy: t.Optional(t.String()),
  taxonomyKey: t.String(),
  mentionCount: t.Number(),
  explicitness: t.Union([t.Literal('explicit'), t.Literal('inferred'), t.Literal('uncertain')])
});

const manualTranscriptSchema = t.Object({
  source: t.Literal('manual_transcript'),
  id: t.String(),
  createdAt: t.String(),
  conversationDate: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  fileName: t.String(),
  rawTranscript: t.String(),
  storageState: t.Union([t.Literal('s3'), t.Literal('in-memory-demo')]),
  objectKey: t.Optional(t.String()),
  durationSeconds: t.Optional(t.Number()),
  representativeId: t.String(),
  representativeName: t.Optional(t.String()),
  representativeInitials: t.Optional(t.String()),
  territoryId: t.String(),
  territoryName: t.Optional(t.String()),
  city: t.Optional(t.String()),
  outletId: t.Optional(t.String()),
  outletName: t.String(),
  outcome: t.Union([
    t.Literal('order_placed'), t.Literal('follow_up'), t.Literal('no_order'),
    t.Literal('new_outlet'), t.Literal('not_stated')
  ]),
  outcomeEvidenceSegmentIds: t.Array(t.String()),
  confirmedOrderValueInr: t.Optional(t.Number()),
  sentimentCue: t.Union([
    t.Literal('positive'), t.Literal('neutral'), t.Literal('hesitant'), t.Literal('at_risk'), t.Literal('unknown')
  ]),
  sentimentConfidence: t.Union([t.Literal('high'), t.Literal('medium'), t.Literal('low')]),
  summary: t.String(),
  nextAction: t.Optional(t.String()),
  nextActionEvidenceSegmentIds: t.Optional(t.Array(t.String())),
  nextActionDue: t.Optional(t.String()),
  productsDiscussed: t.Array(t.String()),
  transcript: t.Array(transcriptSegmentSchema),
  insights: t.Array(transcriptInsightSchema),
  coachingSignals: t.Array(t.Object({
    rubricKey: t.Union([
      t.Literal('discovery'), t.Literal('benefit_explanation'),
      t.Literal('objection_response'), t.Literal('close_or_next_step')
    ]),
    label: t.String(),
    confidence: t.Union([t.Literal('high'), t.Literal('medium'), t.Literal('low')]),
    evidenceSegmentIds: t.Array(t.String()),
    note: t.String()
  }))
});

const manualTranscriptPageSchema = t.Object({
  transcripts: t.Array(manualTranscriptSchema),
  total: t.Number()
});

const createManualTranscriptBody = t.Object({
  fileName: t.String({ minLength: 1, maxLength: 255 }),
  outletName: t.String({ minLength: 1, maxLength: 200 }),
  representativeId: t.String({ minLength: 1, maxLength: 128 }),
  territoryId: t.String({ minLength: 1, maxLength: 128 }),
  transcriptText: t.String({ minLength: 1, maxLength: 100000 }),
  createdAt: t.Optional(t.String({ format: 'date-time' })),
  conversationDate: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  consentConfirmed: t.Boolean()
});

const transcriptParams = t.Object({ transcriptId: t.String({ minLength: 1, maxLength: 128 }) });

export interface ApiRuntimeInfo {
  persistence: 'in-memory-demo' | 'mongodb';
  uploads: 'configured' | 'not-configured';
  analysis: 'not-configured';
  storageDriver: 'local' | 's3';
}

/**
 * Create the API around a replaceable repository. The default adapter is
 * process-local demo storage: a restart clears visits and recording metadata.
 */
export function createApp(
  repository: RecordingRepository = new DemoRecordingRepository(),
  uploads: S3RecordingUploads = new S3RecordingUploads(),
  transcripts: ManualTranscriptRepository = new InMemoryManualTranscriptRepository(),
  localStorage: LocalRecordingStorage = new LocalRecordingStorage(Bun.env.LOCAL_UPLOAD_STAGING_DIR ?? './var/upload-staging'),
  recordingStorage: RecordingObjectStorage = createRecordingStorage(readStorageConfig())
) {
  return new Elysia()
    .get('/health', () => ({
      status: 'ok' as const,
      service: 'itc-field-source-api',
      runtime: {
        persistence: repository instanceof DemoRecordingRepository ? 'in-memory-demo' as const : 'mongodb' as const,
        uploads: uploads.configured ? 'configured' as const : 'not-configured' as const,
        analysis: 'not-configured' as const,
        storageDriver: recordingStorage.driver
      } satisfies ApiRuntimeInfo
    }))
    .post('/v1/transcripts', {
      body: createManualTranscriptBody,
      response: {
        201: manualTranscriptSchema,
        400: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ body, status }) => {
      if (!body.consentConfirmed) {
        return status(400, {
          code: 'transcript_consent_required',
          message: 'Confirm that the transcript was collected with consent before importing it.'
        });
      }
      if (!body.fileName.trim() || !body.outletName.trim() || !body.representativeId.trim() || !body.territoryId.trim() || !body.transcriptText.trim()) {
        return status(400, {
          code: 'transcript_fields_required',
          message: 'Provide a file name, outlet, representative, territory, and non-empty transcript text.'
        });
      }
      if (body.conversationDate) {
        const dateParts = body.conversationDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const date = dateParts
          ? new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3])))
          : undefined;
        if (!dateParts || !date
          || date.getUTCFullYear() !== Number(dateParts[1])
          || date.getUTCMonth() !== Number(dateParts[2]) - 1
          || date.getUTCDate() !== Number(dateParts[3])) {
          return status(400, {
            code: 'invalid_conversation_date',
            message: 'The conversation date must be a real calendar date in YYYY-MM-DD format.'
          });
        }
      }

      const id = crypto.randomUUID();
      const createdAt = body.createdAt ? new Date(body.createdAt).toISOString() : new Date().toISOString();
      const analysis = analyzeManualTranscript({
        id,
        createdAt,
        ...(body.conversationDate ? { conversationDate: body.conversationDate } : {}),
        fileName: body.fileName.trim(),
        rawTranscript: body.transcriptText,
        outletName: body.outletName.trim(),
        representativeId: body.representativeId.trim(),
        territoryId: body.territoryId.trim()
      });

      let storageState: ManualTranscriptAnalysis['storageState'] = 'in-memory-demo';
      let objectKey: string | undefined;
      if (uploads.configured) {
        try {
          const stored = await uploads.storeTranscript({
            id,
            createdAt,
            fileName: body.fileName.trim(),
            text: body.transcriptText
          });
          storageState = 's3';
          objectKey = stored.objectKey;
        } catch {
          return status(503, {
            code: 'transcript_s3_store_failed',
            message: 'The transcript could not be stored in S3. No report was added; check API AWS credentials and retry.'
          });
        }
      }

      const result: ManualTranscriptAnalysis = {
        ...analysis,
        storageState,
        ...(objectKey ? { objectKey } : {})
      };
      transcripts.create(result);
      return status(201, result);
    })
    .get('/v1/transcripts', {
      response: { 200: manualTranscriptPageSchema }
    }, () => transcripts.list())
    .get('/v1/transcripts/:transcriptId', {
      params: transcriptParams,
      response: {
        200: manualTranscriptSchema,
        404: errorSchema
      }
    }, ({ params, status }) => {
      const transcript = transcripts.get(params.transcriptId);
      if (!transcript) return status(404, { code: 'transcript_not_found', message: 'The requested manual transcript was not found in this demo API instance.' });
      return transcript;
    })
    .post('/v1/visits', {
      body: createVisitBody,
      response: {
        200: visitSchema,
        201: visitSchema,
        409: errorSchema
      }
    }, async ({ body, status }) => {
      const result = await repository.createVisit(body);
      if (result.kind === 'conflict') {
        return status(409, {
          code: 'visit_id_conflict',
          message: 'A different visit already uses this id.'
        });
      }
      return result.kind === 'existing' ? status(200, result.value) : status(201, result.value);
    })
    .get('/v1/visits/:visitId', {
      params: visitParams,
      response: {
        200: visitSchema,
        404: errorSchema
      }
    }, async ({ params, status }) => {
      const visit = await repository.getVisit(params.visitId);
      if (!visit) {
        return status(404, {
          code: 'visit_not_found',
          message: 'The requested visit does not exist in this demo API instance.'
        });
      }
      return visit;
    })
    .post('/v1/visits/:visitId/recordings', {
      params: visitParams,
      body: createRecordingBody,
      response: {
        200: recordingSchema,
        201: recordingSchema,
        404: errorSchema,
        409: errorSchema
      }
    }, async ({ params, body, status }) => {
      const result = await repository.createRecording(params.visitId, body);
      if (result.kind === 'parent_not_found') {
        return status(404, {
          code: 'visit_not_found',
          message: 'Create the visit before attaching a recording.'
        });
      }
      if (result.kind === 'conflict') {
        return status(409, {
          code: 'recording_id_conflict',
          message: 'This recording id is already attached to a different visit or payload.'
        });
      }
      if (result.kind === 'existing') return status(200, result.value);
      return status(201, result.value);
    })
    .get('/v1/recordings', {
      query: recordingQuery,
      response: recordingPageSchema
    }, async ({ query }) => {
      return repository.listRecordings({
        syncState: query.syncState as SyncState | undefined,
        analysisState: query.analysisState as AnalysisState | undefined,
        representativeId: query.representativeId,
        territoryId: query.territoryId,
        limit: query.limit ?? 25,
        offset: query.offset ?? 0
      });
    })
    .put('/v1/recordings/:recordingId/audio/:chunkIndex/:chunkCount', {
      params: recordingChunkParams,
      response: { 200: t.Object({ received: t.Boolean() }), 404: errorSchema, 409: errorSchema, 500: errorSchema }
    }, async ({ params, request, status }) => {
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'Register visit details before uploading audio.' });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (params.chunkIndex >= params.chunkCount || bytes.byteLength > 1024 * 1024) return status(409, { code: 'invalid_audio_chunk', message: 'The audio chunk is invalid.' });
      try {
        await localStorage.saveChunk({ id: recording.id, startedAt: recording.startedAt, mimeType: recording.mimeType, index: params.chunkIndex, total: params.chunkCount, bytes });
        return { received: true };
      } catch {
        return status(500, { code: 'local_audio_store_failed', message: 'The API could not save audio in its local recordings folder.' });
      }
    })
    .post('/v1/recordings/:recordingId/audio/complete', {
      params: recordingParams,
      response: { 200: recordingSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema }
    }, async ({ params, status }) => {
      let recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'Recording metadata was not found.' });
      try {
        if (recording.syncState === 'uploaded') return recording;
        const bytes = new Uint8Array(await localStorage.read(recording.id, recording.startedAt, recording.mimeType));
        if (bytes.byteLength !== recording.byteLength) return status(409, { code: 'audio_size_mismatch', message: 'Uploaded chunks do not match recording size.' });

        if (recording.syncState === 'error') {
          await repository.transitionSyncState(recording.id, 'queued');
          recording = (await repository.getRecording(recording.id))!;
        }
        if (recording.syncState === 'queued') {
          const started = await repository.transitionSyncState(recording.id, 'uploading');
          if (!started) return status(409, { code: 'recording_upload_conflict', message: 'The recording upload state changed. Retry completion.' });
        } else if (recording.syncState !== 'uploading') {
          return status(409, { code: 'recording_not_uploadable', message: 'The recording is not ready for storage.' });
        }

        const stored = await recordingStorage.putFinal({
          id: recording.id,
          startedAt: recording.startedAt,
          mimeType: recording.mimeType,
          bytes
        });
        const attached = await repository.attachStoredObject(recording.id, stored);
        if (!attached) return status(409, { code: 'recording_metadata_mismatch', message: 'Stored audio did not match the registered recording metadata.' });
        await repository.transitionSyncState(recording.id, 'uploaded', stored.objectKey);
        recording = (await repository.getRecording(recording.id))!;
        await localStorage.removeStaged(recording.id, recording.startedAt, recording.mimeType);
        return recording;
      } catch {
        const current = await repository.getRecording(params.recordingId);
        if (current && (current.syncState === 'queued' || current.syncState === 'uploading')) {
          await repository.transitionSyncState(current.id, 'error');
        }
        return status(500, { code: 'audio_finalize_failed', message: 'The API could not persist the finalized conversation audio. The device copy remains queued for retry.' });
      }
    })
    .get('/v1/recordings/:recordingId/download-url', {
      params: recordingParams,
      response: {
        200: signedUrlSchema,
        404: errorSchema,
        409: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ params, request, status }) => {
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The recording metadata was not found.' });
      if (recording.syncState !== 'uploaded' || !recording.objectKey || !recording.storageDriver) {
        return status(409, { code: 'recording_not_uploaded', message: 'This conversation does not have a stored audio file.' });
      }
      if (recording.storageDriver === 's3') {
        try {
          return {
            ...await recordingStorage.createDownloadUrl(recording.objectKey),
            objectKey: recording.objectKey
          };
        } catch {
          return status(503, { code: 'recording_link_failed', message: 'The API could not create a temporary S3 playback link.' });
        }
      }
      const origin = new URL(request.url).origin;
      return {
        url: new URL(`/v1/recordings/${encodeURIComponent(recording.id)}/audio`, origin).toString(),
        objectKey: recording.objectKey,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      };
    })
    .get('/v1/recordings/:recordingId/audio', {
      params: recordingParams,
      response: { 404: errorSchema, 409: errorSchema }
    }, async ({ params, status }) => {
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The recording metadata was not found.' });
      if (recording.syncState !== 'uploaded' || !recording.objectKey || recording.storageDriver !== 'local') {
        return status(409, { code: 'recording_not_available', message: 'The local audio file is not available.' });
      }
      try {
        const audio = await recordingStorage.readFinal(recording.objectKey);
        const body = new Uint8Array(new ArrayBuffer(audio.byteLength));
        body.set(audio);
        return new Response(body, {
          headers: {
            'Content-Type': recording.mimeType,
            'Content-Length': String(audio.byteLength),
            'Cache-Control': 'private, no-store'
          }
        });
      } catch {
        return status(404, { code: 'recording_file_missing', message: 'The stored local audio file is missing.' });
      }
    })
    .get('/v1/recordings/:recordingId/analysis', {
      params: recordingParams,
      response: {
        200: analysisStatusSchema,
        404: errorSchema
      }
    }, async ({ params, status }) => {
      const analysis = await repository.getAnalysisStatus(params.recordingId);
      if (!analysis) {
        return status(404, {
          code: 'recording_not_found',
          message: 'The requested recording does not exist in this demo API instance.'
        });
      }
      return analysis;
    })
    .get('/v1/recordings/:recordingId', {
      params: recordingParams,
      response: {
        200: recordingSchema,
        404: errorSchema
      }
    }, async ({ params, status }) => {
      const recording: RecordingMetadata | undefined = await repository.getRecording(params.recordingId);
      if (!recording) {
        return status(404, {
          code: 'recording_not_found',
          message: 'The requested recording does not exist in this demo API instance.'
        });
      }
      return recording;
    })
    .get('/v1/recordings/:recordingId/visit', {
      params: recordingParams,
      response: {
        200: visitSchema,
        404: errorSchema
      }
    }, async ({ params, status }) => {
      const visitId = await repository.getRecordingVisitId(params.recordingId);
      if (!visitId) {
        return status(404, {
          code: 'recording_not_found',
          message: 'The recording or its visit does not exist in this demo API instance.'
        });
      }
      const visit = await repository.getVisit(visitId);
      if (!visit) {
        return status(404, {
          code: 'visit_not_found',
          message: 'The visit attached to this recording does not exist in this demo API instance.'
        });
      }
      return visit;
    });
}

export const app = createApp();
export type App = typeof app;
