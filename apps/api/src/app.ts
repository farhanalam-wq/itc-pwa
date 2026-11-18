import { Elysia, t } from 'elysia';
import type { AnalysisState, RecordingMetadata, SyncState } from '@itc/domain';
import {
  DemoRecordingRepository,
  type RecordingRepository
} from './repositories/demo-repository';
import {
  S3RecordingUploads,
  UploadedObjectValidationError
} from './services/s3-recording-uploads';

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
  byteLength: t.Number({ minimum: 0, maximum: 10 * 1024 * 1024 * 1024 })
});

const recordingParams = t.Object({ recordingId: t.String({ minLength: 1, maxLength: 128 }) });
const visitParams = t.Object({ visitId: t.String({ minLength: 1, maxLength: 128 }) });

const recordingQuery = t.Object({
  syncState: t.Optional(syncStateSchema),
  analysisState: t.Optional(analysisStateSchema),
  representativeId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  territoryId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  offset: t.Optional(t.Numeric({ minimum: 0, maximum: 100000 }))
});

const signedUrlSchema = t.Object({
  url: t.String({ format: 'uri' }),
  objectKey: t.String(),
  expiresAt: t.String({ format: 'date-time' })
});

const uploadUnavailableSchema = t.Object({ code: t.String(), message: t.String() });

export interface ApiRuntimeInfo {
  persistence: 'in-memory-demo';
  uploads: 'configured' | 'not-configured';
  analysis: 'not-configured';
}

/**
 * Create the API around a replaceable repository. The default adapter is
 * process-local demo storage: a restart clears visits and recording metadata.
 */
export function createApp(
  repository: RecordingRepository = new DemoRecordingRepository(),
  uploads: S3RecordingUploads = new S3RecordingUploads()
) {
  return new Elysia()
    .get('/health', () => ({
      status: 'ok' as const,
      service: 'itc-field-source-api',
      runtime: {
        persistence: 'in-memory-demo' as const,
        uploads: uploads.configured ? 'configured' as const : 'not-configured' as const,
        analysis: 'not-configured' as const
      } satisfies ApiRuntimeInfo
    }))
    .post('/v1/visits', {
      body: createVisitBody,
      response: {
        200: visitSchema,
        201: visitSchema,
        409: errorSchema
      }
    }, ({ body, status }) => {
      const result = repository.createVisit(body);
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
    }, ({ params, status }) => {
      const visit = repository.getVisit(params.visitId);
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
    }, ({ params, body, status }) => {
      const result = repository.createRecording(params.visitId, body);
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
    }, ({ query }) => {
      return repository.listRecordings({
        syncState: query.syncState as SyncState | undefined,
        analysisState: query.analysisState as AnalysisState | undefined,
        representativeId: query.representativeId,
        territoryId: query.territoryId,
        limit: query.limit ?? 25,
        offset: query.offset ?? 0
      });
    })
    .post('/v1/recordings/:recordingId/upload-url', {
      params: recordingParams,
      response: {
        200: signedUrlSchema,
        404: errorSchema,
        409: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ params, status }) => {
      let recording = repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The recording metadata was not found.' });
      if (!uploads.configured) return status(503, { code: 's3_not_configured', message: 'S3 upload is not configured on the API.' });
      if (recording.syncState === 'uploaded') {
        return status(409, { code: 'recording_already_uploaded', message: 'This recording has already been uploaded.' });
      }

      if (recording.syncState === 'error') {
        repository.transitionSyncState(recording.id, 'queued');
        recording = repository.getRecording(recording.id)!;
      }
      const objectKey = recording.objectKey ?? uploads.objectKeyFor(recording);
      if (recording.syncState === 'queued') {
        const transitioned = repository.transitionSyncState(recording.id, 'uploading', objectKey);
        if (!transitioned) return status(409, { code: 'recording_upload_conflict', message: 'The recording upload state changed. Request a fresh upload target.' });
        recording = repository.getRecording(recording.id)!;
      }
      if (recording.syncState !== 'uploading' || !recording.objectKey) {
        return status(409, { code: 'recording_not_uploadable', message: 'The recording is not ready for an S3 upload.' });
      }

      try {
        return await uploads.createUploadUrl(recording, recording.objectKey);
      } catch {
        repository.transitionSyncState(recording.id, 'error');
        return status(503, { code: 's3_signing_failed', message: 'The API could not sign an S3 upload. Check its AWS credentials and retry.' });
      }
    })
    .post('/v1/recordings/:recordingId/upload-complete', {
      params: recordingParams,
      response: {
        200: recordingSchema,
        404: errorSchema,
        409: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ params, status }) => {
      let recording: RecordingMetadata | undefined = repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The recording metadata was not found.' });
      if (!uploads.configured) return status(503, { code: 's3_not_configured', message: 'S3 upload is not configured on the API.' });
      if (recording.syncState === 'uploaded') return recording;
      if (recording.syncState !== 'uploading' || !recording.objectKey) {
        return status(409, { code: 'recording_not_uploading', message: 'The recording has no active S3 upload to complete.' });
      }
      try {
        await uploads.verifyUploadedObject(recording);
      } catch (error) {
        if (error instanceof UploadedObjectValidationError) {
          repository.transitionSyncState(recording.id, 'error');
          return status(409, { code: 'uploaded_audio_invalid', message: error.message });
        }
        return status(503, { code: 's3_verification_failed', message: 'The API could not verify the S3 upload. Retry completion when the API is reachable.' });
      }
      repository.transitionSyncState(recording.id, 'uploaded', recording.objectKey);
      recording = repository.getRecording(recording.id)!;
      return recording;
    })
    .get('/v1/recordings/:recordingId/download-url', {
      params: recordingParams,
      response: {
        200: signedUrlSchema,
        404: errorSchema,
        409: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ params, status }) => {
      const recording = repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The recording metadata was not found.' });
      if (!uploads.configured) return status(503, { code: 's3_not_configured', message: 'S3 upload is not configured on the API.' });
      if (recording.syncState !== 'uploaded' || !recording.objectKey) {
        return status(409, { code: 'recording_not_uploaded', message: 'This recording does not have an uploaded S3 object.' });
      }
      try {
        return await uploads.createDownloadUrl(recording);
      } catch {
        return status(503, { code: 's3_signing_failed', message: 'The API could not sign an S3 playback link.' });
      }
    })
    .get('/v1/recordings/:recordingId/analysis', {
      params: recordingParams,
      response: {
        200: analysisStatusSchema,
        404: errorSchema
      }
    }, ({ params, status }) => {
      const analysis = repository.getAnalysisStatus(params.recordingId);
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
    }, ({ params, status }) => {
      const recording: RecordingMetadata | undefined = repository.getRecording(params.recordingId);
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
    }, ({ params, status }) => {
      const visitId = repository.getRecordingVisitId(params.recordingId);
      if (!visitId) {
        return status(404, {
          code: 'recording_not_found',
          message: 'The recording or its visit does not exist in this demo API instance.'
        });
      }
      const visit = repository.getVisit(visitId);
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
