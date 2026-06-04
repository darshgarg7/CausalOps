#!/usr/bin/env bash
# Manual acceptance gate for the Kafka event bus.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_URL="${API_URL:-http://localhost:8000}"
COMPOSE="${COMPOSE:-docker compose}"

echo "==> Backend unit tests (no broker required)"
PYTHONPATH=src python3 -m pytest \
  tests/test_bus_serde.py \
  tests/test_bus_summary.py \
  tests/test_bus_kafka_off.py \
  tests/test_bus_kafka_system.py \
  tests/test_coordinator_store.py \
  tests/test_coordinator_refutation.py \
  tests/test_coordinator_runner.py \
  tests/test_worker_dispatch.py \
  tests/test_phase2d_hardening.py \
  tests/test_api_async_run.py \
  tests/test_demo_fixtures.py \
  -m "not kafka" \
  -q

echo "==> Bus Kafka integration tests (broker required)"
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:19092}" PYTHONPATH=src python3 -m pytest \
  tests/test_bus_kafka_system.py \
  -m kafka \
  -q

echo "==> API health"
curl -sf "${API_URL}/health" | grep -q '"status":"ok"'

if ${COMPOSE} ps --status running 2>/dev/null | grep -q redpanda; then
  echo "==> Redpanda topics (expect hivemind.* including hivemind.dlq)"
  ${COMPOSE} exec -T redpanda rpk topic list
  if ${COMPOSE} ps --status running 2>/dev/null | grep -q worker; then
    echo "==> Worker container is running"
  else
    echo "==> WARNING: worker container not running (spawn commands will not execute)"
  fi
else
  echo "==> Skipping Redpanda topic check (redpanda container not running)"
fi

echo "==> Smoke checks passed"
