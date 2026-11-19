import type { ApiError, HealthResponse } from '@itc/contracts';
import type { AnalysisState, ManualTranscriptAnalysis, RecordingMetadata, SyncState } from '@itc/domain';
export type { ManualTranscriptAnalysis } from '@itc/domain';

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken?: () => Promise<string | undefined>;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
}

const DEFAULT_API_REQUEST_TIMEOUT_MS = 25_000;

export interface ApiRuntimeHealth {
  persistence: 'in-memory-demo';
  uploads: 'configured' | 'not-configured';
  analysis: 'not-configured';
}

export interface SignedRecordingUrl {
  url: string;
  objectKey: string;
  expiresAt: string;
}

export type ApiHealthResponse = HealthResponse & { runtime: ApiRuntimeHealth };

export interface VisitRecord {
  id: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  consentRecordedAt: string;
  createdAt: string;
  recordingIds: string[];
}

export interface CreateVisitRequest {
  id: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  consentRecordedAt: string;
}

export type CreateRecordingRequest = Pick<
  RecordingMetadata,
  'id' | 'startedAt' | 'durationSeconds' | 'mimeType' | 'byteLength'
>;

export interface ListRecordingsQuery {
  syncState?: SyncState;
  analysisState?: AnalysisState;
  representativeId?: string;
  territoryId?: string;
  limit?: number;
  offset?: number;
}

export interface RecordingPage {
  recordings: RecordingMetadata[];
  total: number;
  nextOffset: number | null;
}

export interface CreateManualTranscriptRequest {
  fileName: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
  transcriptText: string;
  createdAt?: string;
  conversationDate?: string;
  consentConfirmed: boolean;
}

export interface ManualTranscriptPage {
  transcripts: ManualTranscriptAnalysis[];
  total: number;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiClient {
  getHealth(): Promise<ApiHealthResponse>;
  createVisit(input: CreateVisitRequest): Promise<VisitRecord>;
  getVisit(visitId: string): Promise<VisitRecord>;
  createVisitRecording(visitId: string, input: CreateRecordingRequest): Promise<RecordingMetadata>;
  getRecording(recordingId: string): Promise<RecordingMetadata>;
  listRecordings(query?: ListRecordingsQuery): Promise<RecordingPage>;
  createRecordingUploadUrl(recordingId: string): Promise<SignedRecordingUrl>;
  completeRecordingUpload(recordingId: string): Promise<RecordingMetadata>;
  getRecordingDownloadUrl(recordingId: string): Promise<SignedRecordingUrl>;
  uploadRecordingAudio(recordingId: string, file: Blob, onChunk?: (sent: number, total: number) => void): Promise<RecordingMetadata>;
  ingestTranscript(input: CreateManualTranscriptRequest): Promise<ManualTranscriptAnalysis>;
  listTranscripts(): Promise<ManualTranscriptPage>;
  getTranscript(transcriptId: string): Promise<ManualTranscriptAnalysis>;
}

export function createApiClientOptions(baseUrl: string): ApiClientOptions {
  return { baseUrl };
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof value.code === 'string'
    && 'message' in value
    && typeof value.message === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The API request failed.';
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetcher = options.fetcher ?? globalThis.fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');

    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const token = await options.getAccessToken?.();
    if (token) headers.set('Authorization', 'Bearer ' + token);

    let response: Response;
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) forwardAbort();
    else init.signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      response = await fetcher(baseUrl + path, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (didTimeout) {
        throw new ApiClientError(
          init.method === 'POST' && path === '/v1/transcripts'
            ? 'Transcript import timed out. Check API connectivity, AWS credentials, and s3:PutObject access, then retry.'
            : 'The API request timed out. Check the API connection, then retry.',
          0,
          'request_timeout',
          true
        );
      }
      throw new ApiClientError(errorMessage(error), 0, undefined, true);
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', forwardAbort);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const apiError = isApiError(payload) ? payload : undefined;
      const retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      throw new ApiClientError(
        apiError?.message ?? `The API returned HTTP ${response.status}.`,
        response.status,
        apiError?.code,
        retryable
      );
    }

    return payload as T;
  }

  return {
    getHealth: () => request<ApiHealthResponse>('/health'),
    createVisit: (input) => request<VisitRecord>('/v1/visits', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
    getVisit: (visitId) => request<VisitRecord>('/v1/visits/' + encodeURIComponent(visitId)),
    createVisitRecording: (visitId, input) => request<RecordingMetadata>(
      '/v1/visits/' + encodeURIComponent(visitId) + '/recordings',
      { method: 'POST', body: JSON.stringify(input) }
    ),
    getRecording: (recordingId) => request<RecordingMetadata>(
      '/v1/recordings/' + encodeURIComponent(recordingId)
    ),
    listRecordings: (query = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const queryString = search.toString();
      const suffix = queryString ? '?' + queryString : '';
      return request<RecordingPage>('/v1/recordings' + suffix);
    },
    createRecordingUploadUrl: (recordingId) => request<SignedRecordingUrl>(
      '/v1/recordings/' + encodeURIComponent(recordingId) + '/upload-url',
      { method: 'POST' }
    ),
    completeRecordingUpload: (recordingId) => request<RecordingMetadata>(
      '/v1/recordings/' + encodeURIComponent(recordingId) + '/upload-complete',
      { method: 'POST' }
    ),
    getRecordingDownloadUrl: (recordingId) => request<SignedRecordingUrl>(
      '/v1/recordings/' + encodeURIComponent(recordingId) + '/download-url'
    ),
    uploadRecordingAudio: async (recordingId, file, onChunk) => {
      const chunkSize = 1024 * 1024;
      const total = Math.max(1, Math.ceil(file.size / chunkSize));
      for (let index = 0; index < total; index += 1) {
        const chunk = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));
        await request<{ received: boolean }>(`/v1/recordings/${encodeURIComponent(recordingId)}/audio/${index}/${total}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk
        });
        onChunk?.(index + 1, total);
      }
      return request<RecordingMetadata>(`/v1/recordings/${encodeURIComponent(recordingId)}/audio/complete`, { method: 'POST' });
    },
    ingestTranscript: (input) => request<ManualTranscriptAnalysis>('/v1/transcripts', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
    listTranscripts: () => request<ManualTranscriptPage>('/v1/transcripts'),
    getTranscript: (transcriptId) => request<ManualTranscriptAnalysis>(
      '/v1/transcripts/' + encodeURIComponent(transcriptId)
    )
  };
}
