#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || [ ! -f "$1/go/go.mod" ]; then
    echo "Usage: $0 PATH_TO_X402_CHECKOUT" >&2
    exit 2
fi
task_source=$(CDPATH= cd -- "$1" && pwd -P)
task_harness=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
task_scratch=$(mktemp -d)
trap 'rm -rf "$task_scratch"' 0
cp "$task_harness/main.go" "$task_harness/go.mod" "$task_harness/go.sum" "$task_scratch/"
cd "$task_scratch"
export GOWORK=off GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOMAXPROCS=2
export GOFLAGS='-p=2 -mod=readonly'
go mod edit "-replace=github.com/x402-foundation/x402/go/v2=$task_source/go"
go run .
