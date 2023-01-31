#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE USER queue with encrypted password 'sml-integration-tests';
  CREATE DATABASE queue OWNER queue;
  \connect queue
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EOSQL

