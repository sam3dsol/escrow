#!/bin/bash
# Run the escrow client demo against a local validator. Does not touch the
# global solana config. Override the cluster with ANCHOR_PROVIDER_URL.
set -e
cd "$(dirname "$0")"
URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
WALLET="$HOME/.config/solana/id.json"
ADDR=$(solana address -k "$WALLET")
LOCAL=0
case "$URL" in *127.0.0.1*|*localhost*) LOCAL=1;; esac

if [ "$LOCAL" = "1" ]; then
  echo "==> starting fresh local validator"
  pkill -f solana-test-validator 2>/dev/null || true
  sleep 2
  rm -rf /tmp/escrow-ledger
  solana-test-validator -r -q --ledger /tmp/escrow-ledger > /tmp/escrow-val.log 2>&1 &
  VALPID=$!
  for i in $(seq 1 40); do solana cluster-version --url "$URL" >/dev/null 2>&1 && break; sleep 1; done
  solana airdrop 100 "$ADDR" --url "$URL" >/dev/null
  echo "==> deploying program"
  solana program deploy target/deploy/escrow.so \
    --program-id target/deploy/escrow-keypair.json --url "$URL" -k "$WALLET" 1>/dev/null
fi

echo "==> dedupe nested ESM uuid (web3.js rpc-websockets workaround)"
find node_modules -type d -path '*rpc-websockets/node_modules/uuid' -exec rm -rf {} + 2>/dev/null || true

echo "==> compiling"
set +e
rm -rf .mocha-build
npx tsc -p tsconfig.json

echo "==> running demo"
ANCHOR_PROVIDER_URL="$URL" node .mocha-build/app/demo.js
RC=$?
set -e

[ "$LOCAL" = "1" ] && kill $VALPID 2>/dev/null
exit $RC
