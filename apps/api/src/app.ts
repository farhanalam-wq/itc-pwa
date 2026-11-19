import { Elysia, t } from 'elysia';
import type { AnalysisState, ManualTranscriptAnalysis, RecordingMetadata, RecordingTranscript, SyncState } from '@itc/domain';
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  isAllowedManagerOrigin,
  readAdminSessionToken,
  readManagerOrigin,
  type AdminAuthService
} from './auth/admin-auth';
import {
  DemoRecordingRepository,
  type RecordingRepository
} from './repositories/demo-repository';
import {
  InMemoryManualTranscriptRepository,
  type ManualTranscriptRepository
} from './repositories/manual-transcript-repository';
import { analyzeManualTranscript } from './services/manual-transcript-analysis';
import { LocalRecordingStorage, RECORDING_UPLOAD_CHUNK_BYTES, UploadStagingError } from './services/local-recording-storage';
import { createRecordingStorage, type RecordingObjectStorage } from './services/storage/recording-storage';
import { readStorageConfig } from './services/storage/config';
import type { TranscriptionJobRepository } from './repositories/mongo-transcription-repository';
import type { OpenAITranscriptionWorker } from './services/openai-transcription-worker';
import { OPENAI_TRANSCRIPTION_MODEL, readOpenAITranscriptionConfig } from './services/openai-transcription';
import {
  S3RecordingUploads
} from './services/s3-recording-uploads';

const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

async function readBoundedAudioChunk(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RECORDING_UPLOAD_CHUNK_BYTES) {
    throw new UploadStagingError('Audio transport chunks must be no larger than 1 MiB.', 'upload_invalid');
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RECORDING_UPLOAD_CHUNK_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UploadStagingError('Audio transport chunks must be no larger than 1 MiB.', 'upload_invalid');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

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

const recordingTranscriptSchema = t.Object({
  recordingId: t.String(),
  state: t.Union([
    t.Literal('not_started'), t.Literal('queued'), t.Literal('processing'),
    t.Literal('completed'), t.Literal('failed')
  ]),
  provider: t.Literal('openai'),
  model: t.String(),
  transcriptText: t.Optional(t.String()),
  languageCodes: t.Optional(t.Array(t.String())),
  attempts: t.Number(),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
  completedAt: t.Optional(t.String({ format: 'date-time' })),
  errorCode: t.Optional(t.String()),
  errorMessage: t.Optional(t.String()),
  retryable: t.Optional(t.Boolean())
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
  url: t.String(),
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
const adminIdentitySchema = t.Object({ id: t.String(), email: t.String(), displayName: t.String() });
const adminAuthStatusSchema = t.Object({ adminExists: t.Boolean() });
const adminSetupBody = t.Object({
  email: t.String({ format: 'email', maxLength: 254 }),
  password: t.String({ minLength: 12, maxLength: 128 }),
  displayName: t.String({ minLength: 1, maxLength: 120 })
});
const adminLoginBody = t.Object({
  email: t.String({ format: 'email', maxLength: 254 }),
  password: t.String({ minLength: 1, maxLength: 128 })
});

export interface ApiRuntimeInfo {
  persistence: 'in-memory-demo' | 'mongodb';
  uploads: 'configured' | 'not-configured';
  analysis: 'configured' | 'not-configured';
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
  recordingStorage: RecordingObjectStorage = createRecordingStorage(readStorageConfig()),
  adminAuth?: AdminAuthService,
  transcriptionWorker?: OpenAITranscriptionWorker,
  transcriptionJobs?: TranscriptionJobRepository
) {
  const managerOrigin = readManagerOrigin();
  const sessionCookieSchema = t.Object({
    itc_admin_session: t.Cookie(t.Optional(t.String()), {
      httpOnly: true,
      sameSite: 'lax',
      secure: adminAuth?.cookieSecure ?? Bun.env.NODE_ENV === 'production',
      path: '/',
      maxAge: ADMIN_SESSION_MAX_AGE_SECONDS
    })
  });
  const hasAdminSession = async (request: Request): Promise<boolean> => {
    if (!adminAuth) return false;
    return Boolean(await adminAuth.getSession(readAdminSessionToken(request.headers.get('cookie'))));
  };
  const unauthorizedAdmin = { code: 'admin_auth_required', message: 'Sign in with the administrator account to continue.' };
  const unavailableAuth = { code: 'admin_auth_unavailable', message: 'Administrator authentication is not configured on this API.' };
  const scheduleTranscription = async (recordingId: string): Promise<void> => {
    if (!transcriptionWorker || !transcriptionJobs) return;
    try {
      const job = await transcriptionWorker.enqueue(recordingId);
      if (job.state === 'queued') {
        void transcriptionWorker.runNext(recordingId).catch((error: unknown) => {
          console.error(`Transcription worker failed for recording ${recordingId}:`, error);
        });
      }
    } catch (error) {
      // A transcription queue outage must not undo confirmation of durable audio storage.
      console.error(`Could not queue transcription for recording ${recordingId}:`, error);
    }
  };
  const transcriptFor = async (recordingId: string, recording: RecordingMetadata): Promise<RecordingTranscript> => {
    const job = await transcriptionJobs?.get(recordingId);
    if (job) return job;
    const createdAt = new Date(recording.startedAt).toISOString();
    return {
      recordingId,
      state: 'not_started',
      provider: 'openai',
      model: OPENAI_TRANSCRIPTION_MODEL,
      attempts: 0,
      createdAt,
      updatedAt: createdAt
    };
  };

  return new Elysia()
    .get('/health', () => ({
      status: 'ok' as const,
      service: 'itc-field-source-api',
      runtime: {
        persistence: repository instanceof DemoRecordingRepository ? 'in-memory-demo' as const : 'mongodb' as const,
        uploads: uploads.configured ? 'configured' as const : 'not-configured' as const,
        analysis: readOpenAITranscriptionConfig().configured ? 'configured' as const : 'not-configured' as const,
        storageDriver: recordingStorage.driver
      } satisfies ApiRuntimeInfo
    }))
    .get('/v1/auth/status', {
      response: { 200: adminAuthStatusSchema }
    }, async () => adminAuth ? adminAuth.getStatus() : { adminExists: false })
    .post('/v1/auth/bootstrap', {
      body: adminSetupBody,
      cookie: sessionCookieSchema,
      response: {
        201: adminIdentitySchema,
        403: errorSchema,
        409: errorSchema,
        503: errorSchema
      }
    }, async ({ body, cookie, request, status }) => {
      if (!isAllowedManagerOrigin(request, managerOrigin)) {
        return status(403, { code: 'admin_origin_rejected', message: 'The administrator request origin is not allowed.' });
      }
      if (!adminAuth) return status(503, unavailableAuth);
      const result = await adminAuth.bootstrap(body);
      if (result.ok) {
        cookie.itc_admin_session.value = result.value.token;
        return status(201, result.value.admin);
      }
      return status(409, { code: 'admin_already_created', message: 'The administrator account has already been created.' });
    })
    .post('/v1/auth/login', {
      body: adminLoginBody,
      cookie: sessionCookieSchema,
      response: {
        200: adminIdentitySchema,
        401: errorSchema,
        403: errorSchema,
        503: errorSchema
      }
    }, async ({ body, cookie, request, status }) => {
      if (!isAllowedManagerOrigin(request, managerOrigin)) {
        return status(403, { code: 'admin_origin_rejected', message: 'The administrator request origin is not allowed.' });
      }
      if (!adminAuth) return status(503, unavailableAuth);
      const result = await adminAuth.login(body);
      if (!result) return status(401, { code: 'admin_credentials_invalid', message: 'The email or password is incorrect.' });
      cookie.itc_admin_session.value = result.token;
      return result.admin;
    })
    .get('/v1/auth/session', {
      cookie: sessionCookieSchema,
      response: { 200: adminIdentitySchema, 401: errorSchema, 503: errorSchema }
    }, async ({ cookie, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      const admin = await adminAuth.getSession(cookie.itc_admin_session.value);
      return admin ?? status(401, unauthorizedAdmin);
    })
    .post('/v1/auth/logout', {
      cookie: sessionCookieSchema,
      response: { 200: t.Object({ ok: t.Boolean() }), 403: errorSchema, 503: errorSchema }
    }, async ({ cookie, request, status }) => {
      if (!isAllowedManagerOrigin(request, managerOrigin)) {
        return status(403, { code: 'admin_origin_rejected', message: 'The administrator request origin is not allowed.' });
      }
      if (!adminAuth) return status(503, unavailableAuth);
      await adminAuth.logout(cookie.itc_admin_session.value);
      cookie.itc_admin_session.remove();
      return { ok: true };
    })
    .post('/v1/transcripts', {
      body: createManualTranscriptBody,
      response: {
        201: manualTranscriptSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ body, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
      if (!isAllowedManagerOrigin(request, managerOrigin)) {
        return status(403, { code: 'admin_origin_rejected', message: 'The administrator request origin is not allowed.' });
      }
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
      response: { 200: manualTranscriptPageSchema, 401: errorSchema, 503: errorSchema }
    }, async ({ request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
      return transcripts.list();
    })
    .get('/v1/transcripts/:transcriptId', {
      params: transcriptParams,
      response: {
        200: manualTranscriptSchema,
        401: errorSchema,
        503: errorSchema,
        404: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
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
        401: errorSchema,
        503: errorSchema,
        404: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
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
      response: { 200: recordingPageSchema, 401: errorSchema, 503: errorSchema }
    }, async ({ query, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
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
      response: { 200: t.Object({ received: t.Boolean() }), 400: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema }
    }, async ({ params, request, status }) => {
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'Register visit details before uploading audio.' });
      if (recording.syncState === 'uploaded') return status(409, { code: 'recording_already_uploaded', message: 'This conversation audio is already stored.' });
      if (!Number.isInteger(params.chunkIndex) || !Number.isInteger(params.chunkCount)
        || params.chunkCount < 1 || params.chunkIndex < 0 || params.chunkIndex >= params.chunkCount) {
        return status(409, { code: 'invalid_audio_chunk', message: 'The audio chunk index or count is invalid.' });
      }
      const expectedChunkCount = Math.ceil(recording.byteLength / RECORDING_UPLOAD_CHUNK_BYTES);
      const expectedChunkLength = Math.min(RECORDING_UPLOAD_CHUNK_BYTES, recording.byteLength - params.chunkIndex * RECORDING_UPLOAD_CHUNK_BYTES);
      if (params.chunkCount !== expectedChunkCount || params.chunkIndex >= expectedChunkCount) {
        return status(409, { code: 'invalid_audio_chunk', message: 'The audio chunk size or count does not match the registered recording.' });
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedAudioChunk(request);
      } catch (error) {
        if (error instanceof UploadStagingError) return status(409, { code: error.code, message: error.message });
        return status(400, { code: 'audio_chunk_invalid', message: 'The audio chunk could not be read. Retry from the device.' });
      }
      if (bytes.byteLength !== expectedChunkLength) {
        return status(409, { code: 'invalid_audio_chunk', message: 'The audio chunk size does not match the registered recording.' });
      }
      try {
        await localStorage.saveChunk({
          id: recording.id,
          startedAt: recording.startedAt,
          mimeType: recording.mimeType,
          index: params.chunkIndex,
          total: params.chunkCount,
          expectedByteLength: recording.byteLength,
          bytes
        });
        return { received: true };
      } catch (error) {
        if (error instanceof UploadStagingError) {
          return status(409, { code: error.code, message: error.message });
        }
        return status(500, { code: 'audio_chunk_store_failed', message: 'The API could not safely stage this audio chunk. The device copy remains available for retry.' });
      }
    })
    .post('/v1/recordings/:recordingId/audio/complete', {
      params: recordingParams,
      response: { 200: recordingSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema }
    }, async ({ params, status }) => {
      let recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'Recording metadata was not found.' });
      try {
        if (recording.syncState === 'uploaded') {
          await scheduleTranscription(recording.id);
          return recording;
        }
        const bytes = await localStorage.assemble({
          id: recording.id,
          startedAt: recording.startedAt,
          mimeType: recording.mimeType,
          expectedByteLength: recording.byteLength
        });

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
        const completed = await repository.transitionSyncState(recording.id, 'uploaded', stored.objectKey);
        recording = (await repository.getRecording(recording.id))!;
        if (!completed && recording.syncState !== 'uploaded') {
          return status(503, { code: 'recording_finalize_pending', message: 'The audio is stored, but the API has not confirmed completion yet. Retry sync from the device.' });
        }
        await localStorage.removeStaged(recording.id, recording.startedAt, recording.mimeType).catch(() => undefined);
        await scheduleTranscription(recording.id);
        return recording;
      } catch (error) {
        if (error instanceof UploadStagingError) {
          return status(409, { code: error.code, message: error.message });
        }
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
        401: errorSchema,
        404: errorSchema,
        409: errorSchema,
        503: uploadUnavailableSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
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
      return {
        url: `/api/v1/recordings/${encodeURIComponent(recording.id)}/audio`,
        objectKey: recording.objectKey,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      };
    })
    .get('/v1/recordings/:recordingId/audio', {
      params: recordingParams,
      response: { 401: errorSchema, 404: errorSchema, 409: errorSchema, 503: errorSchema }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
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
        401: errorSchema,
        503: errorSchema,
        404: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
      const analysis = await repository.getAnalysisStatus(params.recordingId);
      if (!analysis) {
        return status(404, {
          code: 'recording_not_found',
          message: 'The requested recording does not exist in this demo API instance.'
        });
      }
      return analysis;
    })
    .get('/v1/recordings/:recordingId/transcript', {
      params: recordingParams,
      response: {
        200: recordingTranscriptSchema,
        401: errorSchema,
        404: errorSchema,
        409: errorSchema,
        503: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
      if (!transcriptionJobs) return status(503, { code: 'transcription_unavailable', message: 'MongoDB transcription storage is not configured.' });
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The requested recording does not exist.' });
      if (recording.syncState !== 'uploaded') return status(409, { code: 'recording_not_stored', message: 'Transcription is available after the audio is durably stored.' });
      try {
        await scheduleTranscription(recording.id);
      } catch {
        // The stored audio remains available; the manager can retry after API configuration is fixed.
      }
      return transcriptFor(recording.id, recording);
    })
    .post('/v1/recordings/:recordingId/transcript/retry', {
      params: recordingParams,
      response: {
        200: recordingTranscriptSchema,
        401: errorSchema,
        404: errorSchema,
        409: errorSchema,
        503: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
      if (!transcriptionJobs || !transcriptionWorker) return status(503, { code: 'transcription_unavailable', message: 'OpenAI transcription is not configured on the API server.' });
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The requested recording does not exist.' });
      if (recording.syncState !== 'uploaded') return status(409, { code: 'recording_not_stored', message: 'Transcription can be retried after the audio is durably stored.' });
      let job = await transcriptionJobs.get(recording.id);
      if (!job) job = await transcriptionWorker.enqueue(recording.id);
      else if (job.state === 'failed') job = await transcriptionJobs.retry(recording.id);
      if (!job) return status(409, { code: 'transcription_not_retryable', message: 'This transcription is not in a retryable state.' });
      if (job.state !== 'queued') return status(409, { code: 'transcription_not_retryable', message: 'This transcription is not waiting for a retry.' });
      void transcriptionWorker.runNext(recording.id).catch((error: unknown) => {
        console.error(`Transcription retry failed for recording ${recording.id}:`, error);
      });
      return job;
    })
    .get('/v1/recordings/:recordingId', {
      params: recordingParams,
      response: {
        200: recordingSchema,
        401: errorSchema,
        503: errorSchema,
        404: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
      const recording: RecordingMetadata | undefined = await repository.getRecording(params.recordingId);
      if (!recording) {
        return status(404, {
          code: 'recording_not_found',
          message: 'The requested recording does not exist in this demo API instance.'
        });
      }
      return recording;
    })
    .get('/v1/recordings/:recordingId/sync', {
      params: recordingParams,
      response: { 200: t.Object({ id: t.String(), syncState: syncStateSchema }), 404: errorSchema }
    }, async ({ params, status }) => {
      const recording = await repository.getRecording(params.recordingId);
      if (!recording) return status(404, { code: 'recording_not_found', message: 'The requested recording does not exist.' });
      return { id: recording.id, syncState: recording.syncState };
    })
    .get('/v1/recordings/:recordingId/visit', {
      params: recordingParams,
      response: {
        200: visitSchema,
        401: errorSchema,
        503: errorSchema,
        404: errorSchema
      }
    }, async ({ params, request, status }) => {
      if (!adminAuth) return status(503, unavailableAuth);
      if (!await hasAdminSession(request)) return status(401, unauthorizedAdmin);
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
