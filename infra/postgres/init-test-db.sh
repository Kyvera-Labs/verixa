#!/bin/sh
# Runs automatically on first container start (see docker-entrypoint-initdb.d
# in the official postgres image docs) to provision a second, separate
# database alongside the main dev one. Tests must never run against the
# same database a developer is interactively poking at with a GUI client —
# a test that truncates a table or a developer's half-finished manual
# migration can silently corrupt the other's state. One Postgres *server*,
# two logically separate databases, is enough isolation for local
# development; Issue 047 replaces this with fully ephemeral per-test-run
# containers (Testcontainers) for CI/automated runs.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE verixa_test;
EOSQL
