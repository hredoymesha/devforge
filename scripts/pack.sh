#!/bin/sh
# Builds dist/devforge-<version>.zip containing only the files the extension needs at runtime.
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/devforge-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json background.js agent.js netcap.js sandbox.html sandbox.js \
  sidepanel.html sidepanel.css panel lib icons -x "*.DS_Store"
echo "$out"
