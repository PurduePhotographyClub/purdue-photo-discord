#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
DEFAULT_DEPLOY_DIR="$ROOT_DIR/deploy/discord-gateway"
DEPLOY_DIR="${1:-$DEFAULT_DEPLOY_DIR}"
DEPLOY_PARENT="$(dirname -- "$DEPLOY_DIR")"

if [ -z "$DEPLOY_DIR" ] || [ "$DEPLOY_DIR" = "/" ] || [ "$DEPLOY_DIR" = "$ROOT_DIR" ]; then
  echo "Refusing to use an unsafe deploy directory: $DEPLOY_DIR" >&2
  exit 1
fi

if [ -L "$DEPLOY_DIR" ]; then
  echo "Refusing to replace a symbolic-link deploy directory: $DEPLOY_DIR" >&2
  exit 1
fi

if [ -e "$DEPLOY_DIR" ]; then
  if [ -L "$DEPLOY_DIR/.git" ] || [ ! -d "$DEPLOY_DIR/.git" ]; then
    echo "Refusing to replace an existing unmarked deploy directory: $DEPLOY_DIR" >&2
    exit 1
  fi

  RESOLVED_DEPLOY_DIR="$(CDPATH='' cd -- "$DEPLOY_DIR" && pwd -P)"
  RESOLVED_DEFAULT_PARENT="$(CDPATH='' cd -- "$(dirname -- "$DEFAULT_DEPLOY_DIR")" && pwd -P)"
  RESOLVED_DEFAULT_DIR="$RESOLVED_DEFAULT_PARENT/$(basename -- "$DEFAULT_DEPLOY_DIR")"
  RESOLVED_GIT_DIR="$(git -C "$DEPLOY_DIR" rev-parse --absolute-git-dir)"
  if [ "$RESOLVED_DEPLOY_DIR" != "$RESOLVED_DEFAULT_DIR" ] || \
    [ "$RESOLVED_GIT_DIR" != "$RESOLVED_DEPLOY_DIR/.git" ]; then
    echo "Refusing to replace an unrecognized deploy repository: $DEPLOY_DIR" >&2
    exit 1
  fi
fi

mkdir -p "$DEPLOY_PARENT"
STAGING_ROOT="$(mktemp -d "$DEPLOY_PARENT/.gateway-release.XXXXXX")"
STAGING_RELEASE="$STAGING_ROOT/release"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT

npm run build:gateway

GITHUB_REPOSITORY="PurduePhotographyClub/purdue-photo-discord" \
GITHUB_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)" \
GITHUB_RUN_ID=1 \
GITHUB_RUN_ATTEMPT=1 \
  node "$ROOT_DIR/apps/discord-gateway/server/gateway-release.mjs" \
    package \
    "$STAGING_RELEASE"

if [ -d "$DEPLOY_DIR/.git" ]; then
  find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -R "$STAGING_RELEASE/." "$DEPLOY_DIR/"
else
  mv "$STAGING_RELEASE" "$DEPLOY_DIR"
  git -C "$DEPLOY_DIR" init -b main
fi

echo "Prepared a verified Gateway release at $DEPLOY_DIR"
echo "Production deployment now runs through the GitHub Actions CI workflow."
