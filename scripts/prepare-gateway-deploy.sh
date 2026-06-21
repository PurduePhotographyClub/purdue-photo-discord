#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
DEPLOY_DIR="${1:-$ROOT_DIR/deploy/discord-gateway}"
GATEWAY_DIR="$ROOT_DIR/apps/discord-gateway"

if [ -z "$DEPLOY_DIR" ] || [ "$DEPLOY_DIR" = "/" ]; then
  echo "Refusing to use an unsafe deploy directory: $DEPLOY_DIR" >&2
  exit 1
fi

npm run build:gateway

mkdir -p "$DEPLOY_DIR"

if [ -d "$DEPLOY_DIR/.git" ]; then
  find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
else
  rm -rf "$DEPLOY_DIR"
  mkdir -p "$DEPLOY_DIR"
  git -C "$DEPLOY_DIR" init -b main
fi

mkdir -p "$DEPLOY_DIR/dist" "$DEPLOY_DIR/server" "$DEPLOY_DIR/systemd"

cp "$GATEWAY_DIR/systemd/pccbot-discord-gateway.service.example" "$DEPLOY_DIR/systemd/pccbot-discord-gateway.service.example"
cp -R "$GATEWAY_DIR/dist/." "$DEPLOY_DIR/dist/"

cat > "$DEPLOY_DIR/package.json" <<'JSON'
{
  "name": "pccbot-discord-gateway-server",
  "version": "1.0.0",
  "description": "Production deploy package for the PPC Discord Gateway forwarder.",
  "type": "module",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "start": "node --enable-source-maps dist/index.js"
  },
  "dependencies": {
    "discord.js": "^14.26.4"
  },
  "engines": {
    "node": ">=22"
  }
}
JSON

cat > "$DEPLOY_DIR/.gitignore" <<'GITIGNORE'
node_modules
*.log
package-lock.json
GITIGNORE

cat > "$DEPLOY_DIR/README.md" <<'MARKDOWN'
# PPC Discord Gateway Server

This deploy repo contains only the VPS-hosted Discord Gateway process.

It does not contain the Cloudflare Worker app, Worker secrets, Wrangler config, slash-command handlers, or website backend code.

## Start

```sh
npm install --omit=dev --ignore-scripts
npm start
```

For production, use the systemd unit in `systemd/pccbot-discord-gateway.service.example`.

## Runtime Configuration

Runtime secrets and deployment-specific settings are managed by the server operator outside this deploy repository.
MARKDOWN

cat > "$DEPLOY_DIR/server/post-receive.example" <<'BASH'
#!/bin/bash
set -euo pipefail

BRANCH="main"
GIT_DIR="/opt/git/pccbot-discord-gateway.git"
WORK_TREE="/opt/pccbot-discord-gateway"
SERVICE_NAME="pccbot-discord-gateway"
SERVICE_USER="pccbot"

run_as_service_user() {
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    "$@"
    return
  fi

  if [ "$(id -u)" = "0" ]; then
    sudo -u "$SERVICE_USER" "$@"
    return
  fi

  echo "Deploy hook must run as $SERVICE_USER or root, not $(id -un)." >&2
  exit 1
}

while read -r _oldrev _newrev refname; do
  if [ "$refname" != "refs/heads/$BRANCH" ]; then
    echo "Skipping $refname; deploy hook only tracks refs/heads/$BRANCH."
    continue
  fi

  echo "Deploying $SERVICE_NAME from $refname."
  run_as_service_user git --git-dir="$GIT_DIR" --work-tree="$WORK_TREE" checkout -f "$BRANCH"
  echo "Checked out $(run_as_service_user git --git-dir="$GIT_DIR" rev-parse --short "$BRANCH")."

  cd "$WORK_TREE"
  run_as_service_user npm install --omit=dev --ignore-scripts

  sudo -n /bin/systemctl restart "$SERVICE_NAME"
  echo "Restarted $SERVICE_NAME."
  sudo -n /bin/systemctl is-active "$SERVICE_NAME"
done
BASH

chmod +x "$DEPLOY_DIR/server/post-receive.example"

echo "Prepared Gateway deploy repo at $DEPLOY_DIR"
echo "Next:"
echo "  cd $DEPLOY_DIR"
echo "  git status"
