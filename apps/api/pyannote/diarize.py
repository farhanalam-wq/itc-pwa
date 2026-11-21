"""Produce Community-1 intervals on the same PCM samples used by the clipper."""

import argparse
from contextlib import redirect_stdout
import json
import os
import sys
from pathlib import Path

MODEL = "pyannote/speaker-diarization-community-1"
SAMPLE_RATE = 16_000


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pcm", type=Path, help="16 kHz mono signed 16-bit PCM")
    args = parser.parse_args()

    if not os.environ.get("HF_TOKEN") and not os.environ.get("PYANNOTE_MODEL_DIR"):
        parser.error("Set HF_TOKEN after accepting the model terms, or set PYANNOTE_MODEL_DIR.")

    # Keep dependency/model output separate from the JSON protocol.
    with redirect_stdout(sys.stderr):
        import torch
        from pyannote.audio import Pipeline

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model_source = os.environ.get("PYANNOTE_MODEL_DIR") or MODEL
        pipeline = Pipeline.from_pretrained(model_source, token=os.environ.get("HF_TOKEN"))
        pipeline.to(device)
        waveform = torch.frombuffer(bytearray(args.pcm.read_bytes()), dtype=torch.int16)
        waveform = waveform.unsqueeze(0).float().div_(32768)
        result = pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE})

    duration_ms = round(waveform.shape[1] / SAMPLE_RATE * 1000)

    def bounded_intervals(segments):
        for segment, fields in segments:
            start_ms = max(0, round(segment.start * 1000))
            end_ms = min(duration_ms, round(segment.end * 1000))
            if start_ms < end_ms:
                yield {"startMs": start_ms, "endMs": end_ms, **fields}

    turns = list(bounded_intervals(
        (segment, {"speaker": speaker})
        for segment, _, speaker in result.exclusive_speaker_diarization.itertracks(yield_label=True)
    ))
    overlaps = list(bounded_intervals(
        (segment, {}) for segment in result.speaker_diarization.get_overlap()
    ))
    print(json.dumps({"source": MODEL, "turns": turns, "overlaps": overlaps}))


if __name__ == "__main__":
    main()
