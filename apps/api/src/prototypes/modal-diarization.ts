import { createHash } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 12 * 60_000;

interface ModalConfig {
  baseUrl: URL;
  key: string;
  secret: string;
}

interface ModalJobResult {
  jobId: string;
  timeline: unknown;
  modelRevision?: string;
  inferenceMs?: number;
  gpu?: string;
}

type HttpRequest = (url: URL, init: RequestInit) => Promise<Response>;

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Modal returned an invalid diarization response.');
  }
  return value as Record<string, unknown>;
}

function parseJobId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) {
    throw new Error('Expected a valid Modal diarization job ID.');
  }
  return value;
}

export function readModalDiarizationConfig(env = Bun.env): ModalConfig {
  const endpoint = env.MODAL_DIARIZATION_URL?.trim();
  const key = env.MODAL_DIARIZATION_KEY?.trim();
  const secret = env.MODAL_DIARIZATION_SECRET?.trim();
  if (!endpoint || !key || !secret) {
    throw new Error('Set MODAL_DIARIZATION_URL, MODAL_DIARIZATION_KEY, and MODAL_DIARIZATION_SECRET to use Modal staging.');
  }
  const baseUrl = new URL(endpoint);
  if (baseUrl.protocol !== 'https:' || !baseUrl.hostname.endsWith('.modal.run') || baseUrl.username
    || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
    throw new Error('MODAL_DIARIZATION_URL must be an HTTPS Modal app origin.');
  }
  return { baseUrl, key, secret };
}

export class ModalDiarizationClient {
  constructor(private readonly config: ModalConfig, private readonly request: HttpRequest = fetch) {}

  async run(pcm: Uint8Array<ArrayBuffer>, options: {
    resumeJobId?: string;
    onJobId?: (jobId: string) => void;
  } = {}): Promise<ModalJobResult> {
    const audioSha256 = createHash('sha256').update(pcm).digest('hex');
    const jobId = options.resumeJobId
      ? parseJobId(options.resumeJobId)
      : await this.submit(pcm);
    options.onJobId?.(jobId);

    const deadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < deadline) {
      let response: Response;
      try {
        response = await this.send(`/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
      } catch {
        // Polling is safe to retry. Submission is not retried after an ambiguous outcome.
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Modal diarization polling returned HTTP ${response.status}.`);
      }
      const status = parseObject(await response.json());
      if (status.state === 'completed') {
        const result = parseObject(status.result);
        if (result.audioSha256 !== audioSha256) {
          throw new Error('This Modal job belongs to a different decoded recording.');
        }
        return {
          jobId,
          timeline: result,
          modelRevision: typeof result.modelRevision === 'string' ? result.modelRevision : undefined,
          inferenceMs: typeof result.inferenceMs === 'number' && Number.isFinite(result.inferenceMs)
            && result.inferenceMs >= 0 ? result.inferenceMs : undefined,
          gpu: typeof result.gpu === 'string' ? result.gpu : undefined
        };
      }
      if (status.state === 'failed') {
        const failure = parseObject(status.error);
        const message = typeof failure.message === 'string' ? failure.message : 'Modal diarization failed.';
        throw new Error(message);
      }
      if (status.state !== 'processing') throw new Error('Modal returned an unknown diarization job state.');
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Modal polling timed out. Resume with --resume-job ${jobId}.`);
  }

  private async submit(pcm: Uint8Array<ArrayBuffer>): Promise<string> {
    const response = await this.send('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm
    });
    if (response.status !== 202) {
      await response.body?.cancel();
      throw new Error(`Modal diarization submission returned HTTP ${response.status}.`);
    }
    return parseJobId(parseObject(await response.json()).jobId);
  }

  private send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Modal-Key', this.config.key);
    headers.set('Modal-Secret', this.config.secret);
    return this.request(new URL(path, this.config.baseUrl), {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  }
}
