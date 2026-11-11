#!/bin/bash
# Run the unit tests under the Node version CI uses.
#
# impunity's loader hooks break on Node 24 (ERR_LOADER_CHAIN_INCOMPLETE), so
# `yarn test` fails before any test loads. Point NODE18_DIR at an unpacked
# Node 18 release (the directory that contains `bin/node`).
#
#   NODE18_DIR=~/.local/node-18.1.0 scripts/test-node18.sh
#
# TZ is forced to UTC like CI; some date tests cross local midnight otherwise.
# Extra arguments are passed through to impunity.

set -euo pipefail

# Already on Node <= 18 (CI, nvm/fnm via .nvmrc): use it as is.
if [ "$(node -p 'process.versions.node.split(".")[0]')" -le 18 ]; then
    NODE_BIN_DIR=""
else
    NODE18_DIR="${NODE18_DIR:-$HOME/.local/node-18.1.0}"
    if [ ! -x "$NODE18_DIR/bin/node" ]; then
        echo "Node $(node -v) can't run impunity and no Node 18 at $NODE18_DIR;" >&2
        echo "set NODE18_DIR to an unpacked Node 18 release." >&2
        exit 1
    fi
    NODE18_DIR="$(cd "$NODE18_DIR" && pwd)"
    NODE18_MAJOR="$("$NODE18_DIR/bin/node" -p 'process.versions.node.split(".")[0]')"
    if [ "$NODE18_MAJOR" -ne 18 ]; then
        echo "Expected Node 18 at $NODE18_DIR/bin/node, found Node $NODE18_MAJOR." >&2
        exit 1
    fi
    NODE_BIN_DIR="$NODE18_DIR/bin:"
fi

cd "$(dirname "$0")/.."
PATH="$NODE_BIN_DIR$PATH" TZ=UTC node node_modules/impunity/cmd.js \
    --entry-point src/platform/web/main.js src/platform/web/Platform.js src/matrix/cygnus/CygnusVerifier.test.js \
    src/matrix/cygnus/CygnusFlows.test.js src/matrix/login/deviceIdLogin.test.js \
    src/matrix/verification/publishCrossSigningKeys.test.js src/matrix/workspace/WorkspaceStorage.test.js \
    src/matrix/workspace/RoomRouter.test.js \
    --force-esm-dirs lib/ src/ --root-dir src/ "$@"
