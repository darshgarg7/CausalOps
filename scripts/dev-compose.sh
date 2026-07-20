#!/usr/bin/env sh
set -eu

docker compose up --build redpanda api worker frontend
