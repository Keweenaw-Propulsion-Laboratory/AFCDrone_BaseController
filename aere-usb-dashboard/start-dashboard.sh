#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR=".venv"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if ! "$VENV_DIR/bin/python" -c "import aiohttp, serial" >/dev/null 2>&1; then
  "$VENV_DIR/bin/python" -m pip install -r requirements.txt
fi

exec "$VENV_DIR/bin/python" server.py "$@"
