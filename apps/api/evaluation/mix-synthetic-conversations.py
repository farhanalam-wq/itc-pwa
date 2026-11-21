"""Mix AI-generated speech into clean and noisy evaluation fixtures.

Placement ranges include quiet audio remaining inside each generated clip.
They are useful for speaker order checks, but are not hand-labeled speech boundaries.
"""

import json
import math
import random
import struct
import subprocess
import sys
import wave
from pathlib import Path


SAMPLE_RATE = 16_000


def decode_voice(path):
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", path,
        "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"
    ])
    clip = [sample for (sample,) in struct.iter_unpack("<h", raw)]
    peak = max(abs(sample) for sample in clip)
    threshold = max(100, peak * 0.025)
    voiced = [i for i, sample in enumerate(clip) if abs(sample) > threshold]
    if not voiced:
        raise ValueError(f"Synthetic speech clip is silent: {path}")
    pad = SAMPLE_RATE // 25
    return clip[max(0, voiced[0] - pad): voiced[-1] + pad]


def add_noise(signal):
    """Apply a reproducible filtered synthetic noise bed at 8 dB global SNR."""
    rng = random.Random(403)
    low = 0
    slow = 0
    bed = []
    for i in range(len(signal)):
        white = rng.gauss(0, 1)
        low = 0.94 * low + 0.06 * white
        slow = 0.994 * slow + 0.006 * white
        t = i / SAMPLE_RATE
        amplitude = 0.84 + 0.12 * math.sin(t * math.tau * 1.1)
        bed.append(amplitude * (0.4 * white + 1.9 * low + 2.3 * slow) + 0.22 * math.sin(t * math.tau * 70))
    scale = math.sqrt(sum(x*x for x in signal) / sum(x*x for x in bed)) / 10 ** (8 / 20)
    return [x + scale * n for x, n in zip(signal, bed)]


def mix(output_dir, source, clips, name, noisy):
    cursor = 0
    placed = []
    for i, clip in enumerate(clips):
        if noisy and i == 2:
            cursor -= int(SAMPLE_RATE * 0.72)
        elif i:
            cursor += int(SAMPLE_RATE * 0.18)
        placed.append((cursor, clip))
        cursor += len(clip)
    total = max(start + len(clip) for start, clip in placed)
    signal = [0.0] * total
    for start, clip in placed:
        for i, sample in enumerate(clip):
            signal[start + i] += sample * 0.65
    if noisy:
        signal = add_noise(signal)

    with wave.open(str(output_dir / f"{name}.wav"), "wb") as audio:
        audio.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        audio.writeframes(struct.pack(
            f"<{total}h", *(max(-32768, min(32767, round(x))) for x in signal)
        ))

    turns = [
        {
            "startMs": round(start / SAMPLE_RATE * 1000),
            "endMs": round((start + len(clip)) / SAMPLE_RATE * 1000),
            **utterance
        }
        for (start, clip), utterance in zip(placed, source)
    ]
    overlaps = [
        {"startMs": turns[2]["startMs"], "endMs": min(turns[1]["endMs"], turns[2]["endMs"])}
    ] if noisy else []
    reference = {"source": "synthetic-known-generation-boundaries", "turns": turns, "overlaps": overlaps}
    (output_dir / f"{name}-reference.json").write_text(
        json.dumps(reference, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    out = Path(sys.argv[1])
    turns = json.loads((out / "reference-text.json").read_text(encoding="utf-8"))
    voices = [decode_voice(out / f"voice-{i}.wav") for i in range(len(turns))]
    mix(out, turns, voices, "clean-intrasentence", False)
    mix(out, turns, voices, "noise-overlap", True)
