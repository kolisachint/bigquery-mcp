#!/usr/bin/env bash
# Runs once after the dev container is created. Must be non-interactive:
# anything that blocks on input will hang container creation.
set -euo pipefail

# Install uv and make it available for the rest of this script.
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# Install the Google Cloud SDK non-interactively and add it to PATH.
curl -LsSf https://sdk.cloud.google.com -o /tmp/install-gcloud.sh
bash /tmp/install-gcloud.sh --disable-prompts --install-dir="$HOME"
export PATH="$HOME/google-cloud-sdk/bin:$PATH"

# Install project dependencies and git hooks.
uv sync
uv run pre-commit install --install-hooks

# NOTE: Application Default Credentials login is interactive (opens a browser),
# so it is intentionally NOT run here. Authenticate manually when ready:
echo
echo "Dev container ready. To authenticate with Google Cloud, run:"
echo "  gcloud auth application-default login"
