import type { DeepFilterSession } from './deepfilter-session';

/** Resume on the Record gesture, then wait for the model before opening capture. */
export async function prepareDenoiserForRecording(
  session: Pick<DeepFilterSession, 'activate' | 'ready' | 'state' | 'reason'>,
  timeoutMs = 120_000
): Promise<void> {
  // Invoke immediately to retain browser user activation during a cold model load.
  const activation = session.activate();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (!await activation) throw new Error('Audio cleanup could not resume (context_resume_failed). Tap Start recording to retry.');
        const result = await session.ready;
        if (result.state !== 'ready' || session.state !== 'ready') {
          throw new Error(`Audio cleanup could not initialize (${session.reason ?? result.reason ?? 'initialization_failed'}). Tap Start recording to retry.`);
        }
        // The context can become suspended while model assets are loading.
        if (!await session.activate()) throw new Error('Audio cleanup could not resume (context_resume_failed). Tap Start recording to retry.');
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Audio preparation timed out (denoiser_prepare_timeout). Check your connection and tap Start recording to retry.')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
