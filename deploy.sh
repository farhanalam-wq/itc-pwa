#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine and the Compose plugin first." >&2
  exit 1
fi
docker compose version >/dev/null

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Deploys are restricted to the main branch. Check out main before running deploy.sh." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree is not clean. Commit or stash changes before deploying." >&2
  exit 1
fi
if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.production.example and fill in the cloud settings." >&2
  exit 1
fi

git pull --ff-only origin main

for name in MANAGER_ORIGIN MONGODB_URI OPENAI_API_KEY MODAL_DIARIZATION_URL MODAL_DIARIZATION_KEY MODAL_DIARIZATION_SECRET AWS_REGION S3_BUCKET_NAME; do
  if ! grep -Eq "^${name}=.+" .env.production || grep -Eq "^${name}=__" .env.production; then
    echo "Set ${name} in .env.production before deployment." >&2
    exit 1
  fi
done

compose=(docker compose --env-file .env.production -f compose.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --remove-orphans
"${compose[@]}" ps

echo "Manager upstream: http://127.0.0.1:4007"
echo "Field PWA upstream: http://127.0.0.1:4008"
echo "API upstream: http://127.0.0.1:4009"
