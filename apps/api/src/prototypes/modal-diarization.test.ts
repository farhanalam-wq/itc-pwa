import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { ModalDiarizationClient, readModalDiarizationConfig } from './modal-diarization';

const config = {
  baseUrl: new URL('https://synthetic.modal.run'),
  key: 'synthetic-key',
  secret: 'synthetic-secret'
};
const jobId = 'fc-synthetic';
const pcm = new Uint8Array([1, 2, 3, 4]);
const timeline = {
  source: 'synthetic',
  audioSha256: createHash('sha256').update(pcm).digest('hex'),
  modelRevision: 'synthetic-revision',
  inferenceMs: 120,
  turns: [],
  overlaps: []
};

test('submits once and resumes polling with the same recording', async () => {
  let submissions = 0;
  let polls = 0;
  const request: ConstructorParameters<typeof ModalDiarizationClient>[1] = async (url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get('Modal-Key')).toBe(config.key);
    expect(headers.get('Modal-Secret')).toBe(config.secret);
    expect(init.redirect).toBe('error');

    if (init.method === 'POST') {
      submissions += 1;
      expect(url.pathname).toBe('/jobs');
      expect(headers.get('Content-Type')).toBe('application/octet-stream');
      expect(init.body).toEqual(pcm);
      return Response.json({ jobId }, { status: 202 });
    }

    expect(url.pathname).toBe(`/jobs/${jobId}`);
    polls += 1;
    return Response.json(polls === 1 ? { state: 'processing' } : { state: 'completed', result: timeline });
  };

  let announced: string | undefined;
  const first = await new ModalDiarizationClient(config, request).run(pcm, {
    onJobId: (id) => { announced = id; }
  });
  expect(first).toEqual({ jobId, timeline, modelRevision: 'synthetic-revision', inferenceMs: 120 });
  expect(announced).toBe(jobId);

  const resumed = await new ModalDiarizationClient(config, request).run(pcm, { resumeJobId: jobId });
  expect(resumed.timeline).toEqual(timeline);
  expect(submissions).toBe(1);

  await expect(new ModalDiarizationClient(config, request).run(new Uint8Array([5, 6]), { resumeJobId: jobId }))
    .rejects.toThrow('different decoded recording');
});

test('does not retry a failed submission', async () => {
  let submissions = 0;
  const client = new ModalDiarizationClient(config, async () => {
    submissions += 1;
    return new Response(null, { status: 503 });
  });
  await expect(client.run(pcm)).rejects.toThrow('submission returned HTTP 503');
  expect(submissions).toBe(1);
});

test('rejects a non-Modal origin before sending credentials', () => {
  expect(() => readModalDiarizationConfig({
    MODAL_DIARIZATION_URL: 'https://example.com',
    MODAL_DIARIZATION_KEY: config.key,
    MODAL_DIARIZATION_SECRET: config.secret
  })).toThrow('HTTPS Modal app origin');
});
