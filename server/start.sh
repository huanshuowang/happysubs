#!/usr/bin/env bash
# Starts the recogniser. Works from anywhere, because it changes into its own
# directory first — the everyday command is this file's path, with no "cd" for
# the reader to get right and no memory of where the install happened.
cd "$(dirname "$0")"
exec .venv/bin/python server.py
