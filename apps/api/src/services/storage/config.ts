import { resolve } from 'node:path';

export type StorageDriver = 'local' | 's3';

export interface StorageConfig {
  driver: StorageDriver;
  localRecordingDir: string;
  awsRegion?: string;
  s3BucketName?: string;
  s3RecordingPrefix: string;
  presignedUrlTtlSeconds: number;
}

export interface MongoConfig {
  uri: string;
  database: string;
}

export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new StorageConfigurationError('S3_PRESIGNED_URL_TTL_SECONDS must be a positive integer.');
  }
  return Math.min(3600, Math.max(60, parsed));
}

function cleanPrefix(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

export function readStorageConfig(env: Record<string, string | undefined> = Bun.env): StorageConfig {
  const driverValue = (env.STORAGE_DRIVER ?? 'local').trim();
  if (driverValue !== 'local' && driverValue !== 's3') {
    throw new StorageConfigurationError('STORAGE_DRIVER must be exactly "local" or "s3".');
  }

  const awsRegion = env.AWS_REGION?.trim() || undefined;
  const s3BucketName = env.S3_BUCKET_NAME?.trim() || undefined;
  if (driverValue === 's3' && (!awsRegion || !s3BucketName)) {
    throw new StorageConfigurationError('STORAGE_DRIVER=s3 requires AWS_REGION and S3_BUCKET_NAME.');
  }

  return {
    driver: driverValue,
    localRecordingDir: resolve(env.LOCAL_RECORDING_DIR?.trim() || './var/recordings'),
    awsRegion,
    s3BucketName,
    s3RecordingPrefix: cleanPrefix(env.S3_RECORDING_PREFIX, 'field-source/recordings'),
    presignedUrlTtlSeconds: positiveInteger(env.S3_PRESIGNED_URL_TTL_SECONDS, 900)
  };
}

/** Mongo is optional for local development; setting MONGODB_URI enables it. */
export function readMongoConfig(env: Record<string, string | undefined> = Bun.env): MongoConfig | undefined {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new StorageConfigurationError('MONGODB_URI must be a valid mongodb:// or mongodb+srv:// URI.');
  }
  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') {
    throw new StorageConfigurationError('MONGODB_URI must use the mongodb:// or mongodb+srv:// scheme.');
  }

  const database = env.MONGODB_DATABASE?.trim() || 'itc_field_source';
  if (database.includes('/') || database.includes('\\')) {
    throw new StorageConfigurationError('MONGODB_DATABASE must be a database name, not a path.');
  }
  return { uri, database };
}
