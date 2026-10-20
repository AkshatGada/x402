#!/bin/zsh
# Usage: ./run.sh baseline|fix   (baseline = main's server/scheme.ts, fix = branch HEAD)
set -e
LABEL=$1
STORE=${STORE:-sqlite}
HERE=${0:A:h}
REPO=${HERE:h:h:h:h:h}  # repo root: harness lives in typescript/packages/mechanisms/svm/.devnet-evidence
FILE=typescript/packages/mechanisms/svm/src/batch-settlement/server/scheme.ts
TSX=$REPO/typescript/node_modules/.bin/tsx
RUN_DIR=$HERE/runs/$LABEL${SUFFIX:-}-$(date +%Y%m%d-%H%M%S)
mkdir -p $RUN_DIR
if [ "$LABEL" = baseline ]; then git -C $REPO show main:$FILE > $REPO/$FILE; else git -C $REPO checkout HEAD -- $FILE; fi
(cd $REPO/typescript/packages/mechanisms/svm && pnpm build > $RUN_DIR/build.log 2>&1)
git -C $REPO rev-parse HEAD > $RUN_DIR/git-head.txt
git -C $REPO diff --stat main -- $FILE > $RUN_DIR/scheme-vs-main.txt || true
echo "scheme.ts sha256: $(shasum -a 256 $REPO/$FILE | cut -d' ' -f1)" >> $RUN_DIR/scheme-vs-main.txt
cleanup() { kill ${PIDS[@]} 2>/dev/null || true; git -C $REPO checkout HEAD -- $FILE; (cd $REPO/typescript/packages/mechanisms/svm && pnpm build > /dev/null 2>&1); }
trap cleanup EXIT
PIDS=()
cd $HERE
$TSX facilitator.mts > $RUN_DIR/facilitator.log 2>&1 & PIDS+=$!
sleep 4
REPLICA=A PORT=4021 DB=$RUN_DIR/run.db STORE=$STORE $TSX server.mts > $RUN_DIR/replica-A.log 2>&1 & PIDS+=$!
sleep 3
REPLICA=B PORT=4022 DB=$RUN_DIR/run.db STORE=$STORE $TSX server.mts > $RUN_DIR/replica-B.log 2>&1 & PIDS+=$!
for i in {1..60}; do curl -s localhost:4021/admin/conflicts >/dev/null && curl -s localhost:4022/admin/conflicts >/dev/null && break; sleep 1; done
SINGLE=$([ "$STORE" = memory ] && echo 1 || echo 0) RUN_DIR=$RUN_DIR LABEL=$LABEL $TSX client.mts 2>&1 | tee $RUN_DIR/client.log
echo "run dir: $RUN_DIR"
