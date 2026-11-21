import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

// Run with: bun run --cwd apps/api evaluation/generate-synthetic-conversations.ts /tmp/itc-evaluation
const [outputArg] = Bun.argv.slice(2);
if (!outputArg || Bun.argv.length !== 3) {
  throw new Error('Pass a directory for the generated evaluation fixtures.');
}
const outputDir = resolve(outputArg);
const source = [
  { speaker: 'A', voice: 'ash', text: 'If আজ তিনটি বাক্স লাগে तो invoice अभी भेज दीजिए before lunch.' },
  { speaker: 'B', voice: 'coral', text: 'हाँ लेकिन delivery কাল সকালে होगी because the shop opens at nine.' },
  { speaker: 'A', voice: 'ash', text: 'Yes, बिल्कुल।' },
  { speaker: 'B', voice: 'coral', text: 'Send me छह पैकेट और তারপর call me.' }
];

await mkdir(outputDir, { recursive: true });
const client = new OpenAI({ maxRetries: 0, timeout: 60_000 });
try {
  await Promise.all(source.map(async (utterance, index) => {
    const speech = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: utterance.voice,
      input: utterance.text,
      response_format: 'wav',
      instructions: 'Read exactly as written in a single conversational breath. Rapidly switch naturally between English, Hindi and Bengali inside the sentence. Do not translate or pause at language switches.'
    });
    await Bun.write(resolve(outputDir, `voice-${index}.wav`), await speech.arrayBuffer());
  }));
} catch (error) {
  if (error instanceof OpenAI.APIError) {
    console.error('Could not generate synthetic speech.', { status: error.status, code: error.code });
    process.exit(1);
  }
  throw error;
}

await Bun.write(
  resolve(outputDir, 'reference-text.json'),
  JSON.stringify(source.map(({ speaker, text }) => ({ speaker, text })), null, 2)
);

const mixer = fileURLToPath(new URL('./mix-synthetic-conversations.py', import.meta.url));
const processResult = Bun.spawn(['python3', mixer, outputDir], { stdout: 'inherit', stderr: 'inherit' });
if (await processResult.exited !== 0) {
  throw new Error('Could not mix the synthetic conversation fixtures.');
}
