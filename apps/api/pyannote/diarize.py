"""Produce Community-1 intervals on the same PCM samples used by the clipper."""

MODEL = "pyannote/speaker-diarization-community-1"
SAMPLE_RATE = 16_000


def pcm_duration_ms(pcm):
    # Match JavaScript Math.round at half-millisecond boundaries.
    bytes_per_ms = SAMPLE_RATE * 2 // 1000
    return (len(pcm) + bytes_per_ms // 2) // bytes_per_ms


def load_pipeline(model_source, token=None, device=None):
    import torch
    from pyannote.audio import Pipeline

    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    pipeline = Pipeline.from_pretrained(model_source, token=token)
    if pipeline is None:
        raise RuntimeError("Could not load the Community-1 model.")
    pipeline.to(torch.device(device))
    return pipeline


def diarize_pcm(pipeline, pcm):
    import torch

    if not pcm or len(pcm) % 2:
        raise ValueError("Expected a nonempty sequence of 16-bit PCM samples.")
    waveform = torch.frombuffer(bytearray(pcm), dtype=torch.int16)
    waveform = waveform.unsqueeze(0).float().div_(32768)
    result = pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE})

    duration_ms = pcm_duration_ms(pcm)

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
    return {"source": MODEL, "turns": turns, "overlaps": overlaps}
