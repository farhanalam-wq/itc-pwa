export const DEEPFILTER_PACKAGE_VERSION = '0.2.0';
export const DEEPFILTER_MODEL_VERSION = 'DeepFilterNet3';
const STORAGE_KEY = 'itc-field-deepfilter-qualification-v1';

export interface QualificationResult {
  qualified: true;
  p95Load: number;
  maxLoad: number;
  windows: number;
  qualifiedAt: string;
  fingerprint: string;
}

function getStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function getQualificationFingerprint(): string {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const buildId = import.meta.env.VITE_APP_BUILD_ID || `${import.meta.env.MODE}:${import.meta.env.BASE_URL}`;
  return [
    nav?.userAgent ?? 'unknown-browser',
    nav?.platform ?? 'unknown-platform',
    nav?.hardwareConcurrency ?? 0,
    nav && 'deviceMemory' in nav ? (nav as Navigator & { deviceMemory?: number }).deviceMemory ?? 0 : 0,
    buildId,
    DEEPFILTER_PACKAGE_VERSION,
    DEEPFILTER_MODEL_VERSION
  ].join('|');
}

export function readQualificationResult(): QualificationResult | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (!stored) return undefined;
    const value = JSON.parse(stored) as QualificationResult;
    if (value.qualified !== true || value.fingerprint !== getQualificationFingerprint()) {
      storage.removeItem(STORAGE_KEY);
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/** Only passing qualification reports are persisted. */
export function persistQualificationResult(input: Pick<QualificationResult, 'p95Load' | 'maxLoad' | 'windows'>): QualificationResult | undefined {
  const storage = getStorage();
  if (input.p95Load >= 0.45 || !storage) return undefined;
  const result: QualificationResult = {
    qualified: true,
    ...input,
    qualifiedAt: new Date().toISOString(),
    fingerprint: getQualificationFingerprint()
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(result));
    return result;
  } catch {
    return undefined;
  }
}
