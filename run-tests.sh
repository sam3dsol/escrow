#!/bin/bash
# Run the escrow test suite against a local agave validator, bypassing
# Anchor 1.0's surfpool default. Does not touch the global solana config.
set -e
cd "$(dirname "$0")"
URL=http://127.0.0.1:8899
WALLET="$HOME/.config/solana/id.json"
ADDR=$(solana address -k "$WALLET")

echo "==> starting fresh local validator"
pkill -f solana-test-validator 2>/dev/null || true
sleep 2
rm -rf /tmp/escrow-ledger
solana-test-validator -r -q --ledger /tmp/escrow-ledger > /tmp/escrow-val.log 2>&1 &
VALPID=$!

echo "==> waiting for RPC"
for i in $(seq 1 40); do
  solana cluster-version --url "$URL" >/dev/null 2>&1 && break
  sleep 1
done

echo "==> funding $ADDR"
solana airdrop 100 "$ADDR" --url "$URL" >/dev/null

echo "==> deploying program"
solana program deploy target/deploy/escrow.so \
  --program-id target/deploy/escrow-keypair.json \
  --url "$URL" -k "$WALLET" 1>/dev/null

echo "==> dedupe nested ESM uuid (web3.js rpc-websockets workaround)"
find node_modules -type d -path '*rpc-websockets/node_modules/uuid' -exec rm -rf {} + 2>/dev/null || true

echo "==> compiling tests to CommonJS"
set +e
rm -rf .mocha-build
npx tsc -p tsconfig.json

echo "==> running tests"
ANCHOR_PROVIDER_URL="$URL" ANCHOR_WALLET="$WALLET" \
  npx mocha ".mocha-build/tests/**/*.js" -t 1000000
RC=$?
set -e

kill $VALPID 2>/dev/null || true
exit $RC
