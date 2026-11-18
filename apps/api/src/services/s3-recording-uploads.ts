import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RecordingMetadata } from '@itc/domain';

export interface S3UploadConfig {
  region?: string;
  bucket?: string;
  /** Prefix for date-partitioned audio objects. */
  prefix: string;
  /** Prefix for date-partitioned plain-text transcript objects. */
  transcriptPrefix: string;
  urlTtlSeconds: number;
}

const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_REQUEST_TIMEOUT_MS = 15_000;

export interface SignedRecordingUrl {
  url: string;
  objectKey: string;
  expiresAt: string;
}

export class UploadNotConfiguredError extends Error {
  constructor() {
    super('S3 upload is not configured. Set AWS_REGION and S3_BUCKET_NAME for the API.');
    this.name = 'UploadNotConfiguredError';
  }
}

export class UploadedObjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadedObjectValidationError';
  }
}

export function readS3UploadConfig(env: Record<string, string | undefined> = Bun.env): S3UploadConfig {
  const ttl = Number(env.S3_PRESIGNED_URL_TTL_SECONDS ?? 900);
  return {
    region: env.AWS_REGION?.trim() || undefined,
    bucket: env.S3_BUCKET_NAME?.trim() || env.S3_BUCKET?.trim() || undefined,
    prefix: (env.S3_RECORDING_PREFIX ?? 'field-source/recordings').replace(/^\/+|\/+$/g, ''),
    transcriptPrefix: (env.S3_TRANSCRIPT_PREFIX ?? 'field-source/transcripts').replace(/^\/+|\/+$/g, ''),
    urlTtlSeconds: Number.isFinite(ttl) ? Math.max(60, Math.min(3600, Math.floor(ttl))) : 900
  };
}

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split(';', 1)[0]?.split('/')[1]?.toLowerCase() ?? '';
  if (subtype === 'webm' || subtype === 'ogg' || subtype === 'wav' || subtype === 'mp4') return subtype;
  if (subtype === 'x-m4a') return 'm4a';
  return 'audio';
}

function dateParts(value: string): [string, string, string] {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return ['unknown', 'unknown', 'unknown'];
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ];
}

function safeFileName(value: string): string {
  const leaf = value.split(/[\\/]/).pop()?.trim() ?? '';
  const cleaned = leaf.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'transcript.txt';
}

export class S3RecordingUploads {
  readonly config: S3UploadConfig;
  private readonly client: S3Client | undefined;

  constructor(config = readS3UploadConfig()) {
    this.config = config;
    this.client = config.region && config.bucket ? new S3Client({
      region: config.region,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true
      }
    }) : undefined;
  }

  get configured(): boolean {
    return Boolean(this.client && this.config.bucket);
  }

  objectKeyFor(recording: RecordingMetadata): string {
    const path = [this.config.prefix, ...dateParts(recording.startedAt), `${encodeURIComponent(recording.id)}.${extensionFor(recording.mimeType)}`]
      .filter(Boolean)
      .join('/');
    return path;
  }

  /** Persist an uploaded transcript as UTF-8 text in its own S3 prefix. */
  async storeTranscript(input: {
    id: string;
    createdAt: string;
    fileName: string;
    text: string;
  }): Promise<{ objectKey: string }> {
    const { client, bucket } = this.requireConfigured();
    const objectKey = [
      this.config.transcriptPrefix,
      ...dateParts(input.createdAt),
      encodeURIComponent(input.id),
      safeFileName(input.fileName)
    ].filter(Boolean).join('/');

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: input.text,
      ContentType: 'text/plain; charset=utf-8'
    }));
    return { objectKey };
  }

  async createUploadUrl(recording: RecordingMetadata, objectKey: string): Promise<SignedRecordingUrl> {
    const { client, bucket } = this.requireConfigured();
    const expiresAt = new Date(Date.now() + this.config.urlTtlSeconds * 1000).toISOString();
    const url = await getSignedUrl(client, new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: recording.mimeType
    }), { expiresIn: this.config.urlTtlSeconds });
    return { url, objectKey, expiresAt };
  }

  async verifyUploadedObject(recording: RecordingMetadata): Promise<void> {
    const { client, bucket } = this.requireConfigured();
    if (!recording.objectKey) throw new UploadedObjectValidationError('The upload target is missing for this recording.');

    let head;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: recording.objectKey }));
    } catch (error) {
      if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) {
        throw new UploadedObjectValidationError('S3 does not have the uploaded recording yet.');
      }
      throw error;
    }

    if (head.ContentLength !== recording.byteLength) {
      throw new UploadedObjectValidationError('The uploaded audio size does not match the recording metadata.');
    }
    if (head.ContentType && head.ContentType !== recording.mimeType) {
      throw new UploadedObjectValidationError('The uploaded audio type does not match the recording metadata.');
    }
  }

  async createDownloadUrl(recording: RecordingMetadata): Promise<SignedRecordingUrl> {
    const { client, bucket } = this.requireConfigured();
    if (!recording.objectKey) throw new UploadedObjectValidationError('The uploaded recording has no S3 object key.');
    const expiresAt = new Date(Date.now() + this.config.urlTtlSeconds * 1000).toISOString();
    const url = await getSignedUrl(client, new GetObjectCommand({
      Bucket: bucket,
      Key: recording.objectKey
    }), { expiresIn: this.config.urlTtlSeconds });
    return { url, objectKey: recording.objectKey, expiresAt };
  }

  private requireConfigured(): { client: S3Client; bucket: string } {
    if (!this.client || !this.config.bucket) throw new UploadNotConfiguredError();
    return { client: this.client, bucket: this.config.bucket };
  }
}
