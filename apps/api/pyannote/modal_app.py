"""Authenticated asynchronous Community-1 inference for the staging prototype."""

import logging
import os
import re
from hashlib import sha256
from pathlib import Path
from time import perf_counter

import modal

MAX_PCM_BYTES = 19_200_000  # Ten minutes of 16 kHz mono signed 16-bit PCM.
MODEL_REVISION = "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
MODEL_MOUNT = "/model-weights"
MODEL_PATH = f"{MODEL_MOUNT}/community-1/{MODEL_REVISION}"
HF_SECRET_NAME = "itc-pyannote-huggingface"
AUDIO_HELPER = Path(__file__).with_name("diarize.py")
JOB_ID_PATTERN = re.compile(r"fc-[A-Za-z0-9_-]{8,96}")

app = modal.App("itc-pyannote-staging")
weights = modal.Volume.from_name("itc-pyannote-staging-weights", create_if_missing=True)
issued_jobs = modal.Dict.from_name("itc-pyannote-staging-jobs", create_if_missing=True)
logger = logging.getLogger(__name__)

hub_requirement = "huggingface-hub==2.4.0"
download_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(hub_requirement)
    .add_local_file(AUDIO_HELPER, "/root/diarize.py")
)
gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.11.0+cu128",
        "torchaudio==2.11.0+cu128",
        extra_index_url="https://download.pytorch.org/whl/cu128",
    )
    .pip_install("torchcodec==0.12.0", hub_requirement)
    .pip_install_from_requirements(str(AUDIO_HELPER.with_name("requirements.txt")))
    .env({
        "HF_HUB_OFFLINE": "1",
        "PYANNOTE_METRICS_ENABLED": "0",
        "OMP_NUM_THREADS": "2",
    })
    .add_local_file(AUDIO_HELPER, "/root/diarize.py")
)
web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi==0.121.3")


@app.function(
    image=download_image,
    volumes={MODEL_MOUNT: weights},
    secrets=[modal.Secret.from_name(HF_SECRET_NAME, required_keys=["HF_TOKEN"])],
    timeout=600,
)
def download_model():
    """Cache the pinned Community-1 snapshot before deploying the web service."""
    from diarize import MODEL
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=MODEL,
        revision=MODEL_REVISION,
        local_dir=MODEL_PATH,
        token=os.environ["HF_TOKEN"],
    )
    weights.commit()
    print(f"Cached {MODEL}@{MODEL_REVISION}.")


@app.cls(
    image=gpu_image,
    gpu="L4",
    cpu=2,
    memory=4096,
    max_containers=2,
    scaledown_window=60,
    timeout=300,
    volumes={MODEL_MOUNT: weights.with_mount_options(read_only=True)},
)
class Diarizer:
    @modal.enter()
    def load_model(self):
        from diarize import load_pipeline

        if not Path(MODEL_PATH, "config.yaml").is_file():
            raise RuntimeError("The pinned Community-1 snapshot is missing. Run download_model first.")
        self.pipeline = load_pipeline(MODEL_PATH, device="cuda")

    @modal.method()
    def run(self, pcm: bytes):
        from diarize import diarize_pcm, pcm_duration_ms

        started_at = perf_counter()
        result = diarize_pcm(self.pipeline, pcm)
        return {
            **result,
            "audioSha256": sha256(pcm).hexdigest(),
            "durationMs": pcm_duration_ms(pcm),
            "modelRevision": MODEL_REVISION,
            "inferenceMs": round((perf_counter() - started_at) * 1000),
        }


@app.function(image=web_image, memory=512)
@modal.asgi_app(requires_proxy_auth=True)
def api():
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def error(code, message, retryable):
        return {"code": code, "message": message, "retryable": retryable}

    @web.post("/jobs", status_code=202)
    async def submit(request: Request):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/octet-stream":
            return JSONResponse(
                {"error": error("unsupported_media_type", "Send raw PCM as application/octet-stream.", False)},
                status_code=415,
            )

        pcm = bytearray()
        async for chunk in request.stream():
            if len(pcm) + len(chunk) > MAX_PCM_BYTES:
                return JSONResponse(
                    {"error": error("audio_too_large", "PCM exceeds the ten-minute staging limit.", False)},
                    status_code=413,
                )
            pcm.extend(chunk)
        if not pcm or len(pcm) % 2:
            return JSONResponse(
                {"error": error("invalid_pcm", "Send a nonempty sequence of 16-bit PCM samples.", False)},
                status_code=400,
            )

        try:
            call = await Diarizer().run.spawn.aio(bytes(pcm))
            await issued_jobs.put.aio(call.object_id, True)
        except Exception as exc:
            logger.warning("Could not submit diarization: %s", type(exc).__name__)
            return JSONResponse(
                {"error": error("submit_failed", "Modal could not submit the job.", True)},
                status_code=503,
            )
        return {"jobId": call.object_id}

    @web.get("/jobs/{job_id}")
    async def status(job_id: str):
        if not JOB_ID_PATTERN.fullmatch(job_id):
            return JSONResponse(
                {"error": error("invalid_job_id", "Invalid diarization job ID.", False)},
                status_code=400,
            )

        try:
            if not await issued_jobs.contains.aio(job_id):
                return {
                    "state": "failed",
                    "error": error("job_unavailable", "Unknown or expired diarization job.", False),
                }
            call = modal.FunctionCall.from_id(job_id)
            result = await call.get.aio(timeout=0)
        except modal.exception.FunctionTimeoutError:
            return {
                "state": "failed",
                "error": error("diarization_timeout", "Diarization exceeded its processing time limit.", True),
            }
        except TimeoutError:
            return {"state": "processing"}
        except (modal.exception.NotFoundError, modal.exception.OutputExpiredError):
            return {
                "state": "failed",
                "error": error("job_unavailable", "The diarization job is unknown or its result expired.", False),
            }
        except (
            modal.exception.ConnectionError,
            modal.exception.InternalError,
            modal.exception.ResourceExhaustedError,
            modal.exception.ServiceError,
        ) as exc:
            logger.warning("Could not poll diarization: %s", type(exc).__name__)
            return JSONResponse(
                {"error": error("poll_unavailable", "Modal could not check the job status.", True)},
                status_code=503,
            )
        except Exception as exc:
            logger.warning("Could not retrieve diarization result: %s", type(exc).__name__)
            return {
                "state": "failed",
                "error": error("diarization_failed", "Modal could not complete diarization.", True),
            }
        return {"state": "completed", "result": result}

    return web
