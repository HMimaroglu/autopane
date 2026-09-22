#!/usr/bin/env bash
# macOS / Linux: set everything up on first run, then open Autopane. Safe to re-run.
#   ./run.sh                 set up if needed, then open the app
#   ./run.sh --setup-only    set up and stop
set -euo pipefail
cd "$(dirname "$0")"

SETUP_ONLY=0
if [ "${1:-}" = "--setup-only" ]; then SETUP_ONLY=1; shift; fi

# uv installs and manages its own Python, so no system Python is needed.
if ! command -v uv >/dev/null; then
  echo "Installing uv (Python manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
if ! command -v node >/dev/null; then
  if command -v brew >/dev/null; then
    brew install node
  else
    echo "Autopane needs Node 20+: install it from https://nodejs.org and run this again." >&2
    exit 1
  fi
fi
if ! command -v git >/dev/null; then
  echo "Autopane needs git: on macOS run 'xcode-select --install', then run this again." >&2
  exit 1
fi
command -v claude >/dev/null || echo "Note: the claude CLI is not on PATH; install and sign in (https://claude.com/claude-code) before running a task." >&2

PY=engine/.venv/bin/python
if [ ! -f engine/.venv/.ready ]; then
  echo "Setting up the model runtime..."
  rm -rf engine/.venv
  uv venv -q --python 3.12 engine/.venv
  uv pip install -q --python "$PY" -r engine/requirements.txt
  # Without Apple Silicon or an NVIDIA GPU the model runs on CPU through llama.cpp.
  if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ] && ! command -v nvidia-smi >/dev/null; then
    uv pip install -q --python "$PY" "llama-cpp-python==0.3.35"
  fi
  touch engine/.venv/.ready
fi

CONFIG="$HOME/.autopane/config.json"
if [ ! -s "$CONFIG" ]; then
  echo "Downloading the decision model (one time, a few GB)..."
  mkdir -p "$HOME/.autopane"
  "$PY" engine/prepare_model.py | tail -1 > "$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
fi

if [ ! -f app/node_modules/.ready ]; then
  echo "Installing the app..."
  (cd app && npm ci --silent && touch node_modules/.ready)
fi

[ "$SETUP_ONLY" = 1 ] && { echo "Setup complete."; exit 0; }
cd app && exec ./node_modules/.bin/electron . "$@"
