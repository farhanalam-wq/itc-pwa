import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { LocalRecordingStorage } from '../local-recording-storage';
import type { StorageConfig } from './config';

export interface StoredRecordingObject {
  driver: 'local' | 's3';
  objectKey: string;
  byteLength: number;
  mimeType: string;
  sha256: string;
}

export interface FinalRecordingInput {
  id: string;
  startedAt: string;
  mimeType: string;
  /** Complete merged conversation bytes. Transport chunks must be assembled before this call. */
  bytes: Uint8Array;
  /** Names the separately stored denoised analysis artifact while preserving the original key. */
  artifact?: 'analysis';
}

export interface RecordingObjectStorage {
  readonly driver: 'local' | 's3';
  putFinal(input: FinalRecordingInput): Promise<StoredRecordingObject>;
  readFinal(objectKey: string, driver?: 'local' | 's3'): Promise<Uint8Array>;
  deleteFinal(objectKey: string, driver: 'local' | 's3'): Promise<void>;
  createDownloadUrl(objectKey: string): Promise<{ url: string; expiresAt: string }>;
}

export class RecordingStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingStorageError';
  }
}

function datePath(startedAt: string): string[] {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) throw new RecordingStorageError('Recording start time is invalid.');
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ];
}

function audioExtension(mimeType: string): string {
  const subtype = mimeType.split(';', 1)[0]?.split('/')[1]?.toLowerCase() ?? '';
  if (subtype === 'x-m4a') return 'm4a';
  if (['webm', 'ogg', 'wav', 'mp4', 'mpeg', 'mp3', 'aac', 'm4a'].includes(subtype)) return subtype;
  return 'audio';
}

function stableKey(prefix: string, input: Pick<FinalRecordingInput, 'id' | 'startedAt' | 'mimeType' | 'artifact'>): string {
  if (!input.id.trim() || input.id.includes('/') || input.id.includes('\\') || input.id === '.' || input.id === '..') {
    throw new RecordingStorageError('Recording id is invalid for object storage.');
  }
  const suffix = input.artifact === 'analysis' ? '.analysis' : '';
  return [prefix, ...datePath(input.startedAt), `${encodeURIComponent(input.id)}${suffix}.${audioExtension(input.mimeType)}`]
    .filter(Boolean)
    .join('/');
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class LocalObjectStorage implements RecordingObjectStorage {
  readonly driver = 'local' as const;
  private readonly local: LocalRecordingStorage;

  constructor(private readonly config: StorageConfig) {
    this.local = new LocalRecordingStorage(config.localRecordingDir);
  }

  async putFinal(input: FinalRecordingInput): Promise<StoredRecordingObject> {
    // LocalRecordingStorage writes the merged file under date/id and returns a stable relative key.
    const objectKey = await this.local.save(input);
    return {
      driver: this.driver,
      objectKey,
      byteLength: input.bytes.byteLength,
      mimeType: input.mimeType,
      sha256: hash(input.bytes)
    };
  }

  async readFinal(objectKey: string): Promise<Uint8Array> {
    return readFile(this.localPath(objectKey));
  }

  async deleteFinal(objectKey: string): Promise<void> {
    await rm(this.localPath(objectKey), { force: true });
  }

  private localPath(objectKey: string): string {
    const relativeKey = this.localRelativeKey(objectKey);
    const absolute = resolve(this.config.localRecordingDir, relativeKey);
    const relativePath = relative(this.config.localRecordingDir, absolute);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new RecordingStorageError('Recording object key is outside the local storage directory.');
    }
    return absolute;
  }

  async createDownloadUrl(objectKey: string): Promise<{ url: string; expiresAt: string }> {
    // The API should proxy local playback through an authenticated route.
    throw new RecordingStorageError(`Local recording playback must be served by the API route (${objectKey}).`);
  }

  private localRelativeKey(objectKey: string): string {
    const normalized = objectKey.replaceAll('\\', '/');
    const prefix = 'local-recordings/';
    if (!normalized.startsWith(prefix)) throw new RecordingStorageError('Recording is not stored by the local adapter.');
    const key = normalized.slice(prefix.length);
    if (key.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new RecordingStorageError('Recording object key is invalid.');
    }
    return key;
  }
}

class S3ObjectStorage implements RecordingObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    if (!config.awsRegion || !config.s3BucketName) {
      throw new RecordingStorageError('S3 storage requires AWS_REGION and S3_BUCKET_NAME.');
    }
    this.client = new S3Client({ region: config.awsRegion, maxAttempts: 3 });
  }

  async putFinal(input: FinalRecordingInput): Promise<StoredRecordingObject> {
    const { s3BucketName, s3RecordingPrefix } = this.config;
    if (!s3BucketName) throw new RecordingStorageError('S3 bucket is not configured.');
    const objectKey = stableKey(s3RecordingPrefix, input);
    const checksum = hash(input.bytes);

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: s3BucketName,
        Key: objectKey,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.mimeType,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        IfNoneMatch: '*',
        Metadata: { 'recording-id': input.id, sha256: checksum }
      }));
    } catch (error) {
      const preconditionFailed = error instanceof Error && error.name === 'PreconditionFailed';
      if (!preconditionFailed) throw error;

      // The previous request may have stored the file before the API could confirm it.
      const existing = await this.client.send(new HeadObjectCommand({ Bucket: s3BucketName, Key: objectKey }));
      if (existing.ContentLength !== input.bytes.byteLength || existing.ContentType !== input.mimeType
        || existing.Metadata?.sha256 !== checksum) {
        throw new RecordingStorageError('The S3 key already contains different audio.');
      }
    }

    return {
      driver: this.driver,
      objectKey,
      byteLength: input.bytes.byteLength,
      mimeType: input.mimeType,
      sha256: checksum
    };
  }

  async readFinal(objectKey: string): Promise<Uint8Array> {
    const { s3BucketName } = this.config;
    if (!s3BucketName) throw new RecordingStorageError('S3 bucket is not configured.');
    const result = await this.client.send(new GetObjectCommand({ Bucket: s3BucketName, Key: objectKey }));
    if (!result.Body) throw new RecordingStorageError('The S3 recording has an empty response body.');
    return new Uint8Array(await result.Body.transformToByteArray());
  }

  async deleteFinal(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.s3BucketName, Key: objectKey }));
  }

  async createDownloadUrl(objectKey: string): Promise<{ url: string; expiresAt: string }> {
    const { s3BucketName, presignedUrlTtlSeconds } = this.config;
    if (!s3BucketName) throw new RecordingStorageError('S3 bucket is not configured.');
    const expiresAt = new Date(Date.now() + presignedUrlTtlSeconds * 1000).toISOString();
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: s3BucketName, Key: objectKey }), {
      expiresIn: presignedUrlTtlSeconds
    });
    return { url, expiresAt };
  }
}

export function createRecordingStorage(config: StorageConfig): RecordingObjectStorage {
  const local = new LocalObjectStorage(config);
  const s3 = config.awsRegion && config.s3BucketName ? new S3ObjectStorage(config) : undefined;
  const active = config.driver === 's3' ? (s3 ?? new S3ObjectStorage(config)) : local;
  const forDriver = (driver: 'local' | 's3') => {
    if (driver === 'local') return local;
    if (s3) return s3;
    throw new RecordingStorageError('S3 storage is unavailable.');
  };

  return {
    driver: active.driver,
    putFinal: (input) => active.putFinal(input),
    readFinal: (objectKey, driver = active.driver) => forDriver(driver).readFinal(objectKey),
    deleteFinal: (objectKey, driver) => forDriver(driver).deleteFinal(objectKey),
    createDownloadUrl: (objectKey) => forDriver('s3').createDownloadUrl(objectKey)
  };
}
