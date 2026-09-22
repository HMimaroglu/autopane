#!/usr/bin/env bash
# Set up everything on first run, then open Autopane. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null || { echo "Autopane needs $1 on PATH: $2" >&2; exit 1; }; }
need node "install Node 20+ from https://nodejs.org"
need git "install git"
command -v claude >/dev/null || echo "warning: the claude CLI is not on PATH; planning will fail until it is (https://claude.com/claude-code)" >&2

PY=engine/.venv/bin/python
if [ ! -x "$PY" ]; then
  echo "Creating the model environment…"
  if command -v uv >/dev/null; then
    uv venv -q --python 3.12 engine/.venv
    PIP=(uv pip install -q --python "$PY")
  else
    need python3 "install Python 3.10+"
    python3 -m venv engine/.venv
    PIP=("$PY" -m pip install -q)
  fi
  "${PIP[@]}" -r engine/requirements.txt
  # Without Apple Silicon or an NVIDIA GPU the model runs on CPU through llama.cpp.
  if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ] && ! command -v nvidia-smi >/dev/null; then
    "${PIP[@]}" "llama-cpp-python==0.3.35"
  fi
fi

CONFIG="$HOME/.autopane/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "Downloading and preparing the decision model (one time, ~9 GB download, 4.5 GB kept)…"
  mkdir -p "$HOME/.autopane"
  "$PY" engine/prepare_model.py | tail -1 > "$CONFIG"
fi

if [ ! -d app/node_modules ]; then
  echo "Installing the app…"
  (cd app && npm install --silent)
fi

cd app && exec npx electron . "$@"
