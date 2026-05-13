#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/seb-server"
LOCAL_TEST_DIR="$SERVER_DIR/local-test"
RUNTIME_DIR="${NSEB_SERVE_RUNTIME_DIR:-$ROOT_DIR/.serve}"
SERVER_BASE_URL="${NSEB_SERVE_SERVER_BASE_URL:-http://127.0.0.1:18080}"
EXAM_BASE_URL="${NSEB_SERVE_EXAM_BASE_URL:-http://127.0.0.1:18180}"
CLIENT_CONFIG_OUTPUT="$RUNTIME_DIR/local-exam-client.seb"
METADATA_OUTPUT="$RUNTIME_DIR/local-exam-metadata.json"
CONFIG_TEMPLATE="$LOCAL_TEST_DIR/test-exam/local-exam-template.seb"
SKIP_BUILD="${NSEB_SERVE_SKIP_BUILD:-0}"
MAVEN_CACHE_DIR="${HOME}/.m2"

mkdir -p "$RUNTIME_DIR"
mkdir -p "$MAVEN_CACHE_DIR"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf 'Missing required command: %s\n' "$1" >&2
        exit 1
    fi
}

require_command docker
require_command python3

if [[ "$SKIP_BUILD" != "1" ]]; then
    printf '==> Building seb-server with Dockerized Maven\n'
    docker run --rm \
        -v "$SERVER_DIR":/workspace \
        -v "$MAVEN_CACHE_DIR":/root/.m2 \
        -w /workspace \
        maven:3.9-eclipse-temurin-17 \
        mvn -DskipTests package
else
    printf '==> Reusing existing seb-server build (NSEB_SERVE_SKIP_BUILD=1)\n'
fi

SERVER_JAR="$(find "$SERVER_DIR/target" -maxdepth 1 -type f -name 'seb-server-*.jar' ! -name '*.original' | sort | tail -n 1)"
if [[ -z "$SERVER_JAR" ]]; then
    printf 'Failed to locate built seb-server jar under %s/target\n' "$SERVER_DIR" >&2
    exit 1
fi

cp "$SERVER_JAR" "$SERVER_DIR/seb-server.jar"

printf '==> Resetting local test stack\n'
docker compose -f "$LOCAL_TEST_DIR/docker-compose.yml" down -v --remove-orphans || true

printf '==> Starting local test stack\n'
if [[ "$SKIP_BUILD" == "1" ]]; then
    docker compose -f "$LOCAL_TEST_DIR/docker-compose.yml" up -d
else
    docker compose -f "$LOCAL_TEST_DIR/docker-compose.yml" up --build -d
fi

printf '==> Provisioning local exam and exporting client config\n'
python3 "$ROOT_DIR/scripts/provision-local-exam.py" \
    --server-base-url "$SERVER_BASE_URL" \
    --exam-base-url "$EXAM_BASE_URL" \
    --config-template "$CONFIG_TEMPLATE" \
    --metadata-output "$METADATA_OUTPUT"

CLIENT_CONFIG_ID="$(python3 - <<'PY' "$METADATA_OUTPUT"
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))['clientConfigId'])
PY
)"

EXAM_ID="$(python3 - <<'PY' "$METADATA_OUTPUT"
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))['examId'])
PY
)"

python3 "$ROOT_DIR/scripts/export-local-client-config.py" \
    --server-base-url "$SERVER_BASE_URL" \
    --client-config-id "$CLIENT_CONFIG_ID" \
    --exam-id "$EXAM_ID" \
    --output "$CLIENT_CONFIG_OUTPUT"

printf '\nSEB server: %s\n' "$SERVER_BASE_URL"
printf 'Mock exam:  %s\n' "$EXAM_BASE_URL"
printf 'Client SEB: %s\n' "$CLIENT_CONFIG_OUTPUT"
