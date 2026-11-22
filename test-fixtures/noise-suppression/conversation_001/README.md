# Synthetic retail noise suppression fixture

These files are synthetic test inputs, not recordings from a newly completed field visit. They contain the same Bengali/Hindi/English retail conversation with progressively louder traffic noise.

- `clean_reference.wav`: clean comparison reference.
- `noise_80.wav`, `noise_100.wav`, `noise_125.wav`, `noise_150.wav`: noise RMS is 80%, 100%, 125%, and 150% of speech RMS during active speech.
- `mix_metadata.json`: source levels and measured SNR for each mix.
- `transcript.json` and `ground_truth.json`: synthetic evaluation references. Treat the transcript as a reference, not a guaranteed verbatim label; verify its alignment before calculating transcription error. Ground-truth business facts are scenario expectations and must be supported by transcript evidence before scoring.

All WAV files are mono, 24 kHz PCM16, approximately 4m25s and 12.7 MB each. The DeepFilterNet analysis artifact must be generated at 48 kHz by the browser audio pipeline; these source files are not already denoised.
