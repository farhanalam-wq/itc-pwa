# Synthetic speaker and script evaluation

From the repository root, generate the fixtures using the server's configured OpenAI key. This makes four text-to-speech calls and uses Python and FFmpeg to mix the voices. Keep the generated files outside Git.

```bash
bun run --cwd apps/api evaluation/generate-synthetic-conversations.ts /tmp/itc-evaluation
bun run --cwd apps/api prototype:diarize /tmp/itc-evaluation/clean-intrasentence.wav --transcribe
bun run --cwd apps/api prototype:diarize /tmp/itc-evaluation/noise-overlap.wav --transcribe
```

The two samples use the same two AI-generated voices and four placements. The noisy sample mixes filtered synthetic noise at 8 dB global SNR and inserts an interruption with 720 ms of clip placement overlap. Reference JSON files describe the prompts and placement ranges. Text-to-speech may deviate from its prompt, and placement ranges include silence, so these are checks for regression and comparison rather than ground truth for diarization error rate or word error rate.

## Local results

| Synthetic sample | Speakers and order | GPT clip requests | GPT whole file | GPT clips, sequential |
| --- | --- | ---: | ---: | ---: |
| Clean within-sentence switches (20.56 s) | Two, A → B → A → B | 5 | 1.71 s | 4.89 s |
| Noise and interruption (19.66 s) | Two, A → B → A → B | 7 | 1.48 s | 5.76 s |

Community-1 flagged 557 ms of overlap in the noisy sample. In both samples, GPT still rendered some uninterrupted mixed-language phrases in the wrong script. The noisy clip transcript dropped “at nine” and rendered the short Hindi reply `बिल्कुल` as “Bill Cole.” These results support staging the speaker timeline. They do not establish reliable native-script output in field conditions.
