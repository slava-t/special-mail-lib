#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/test-automation.sh"

for arg in "$@"; do
    case "$arg" in
        --suite|--suite=*)
            echo "Usage error: ci2/scripts/all-tests.sh always runs --suite all; do not pass --suite" >&2
            exit 2
            ;;
    esac
done

exec "$RUNNER" --suite all "$@"
