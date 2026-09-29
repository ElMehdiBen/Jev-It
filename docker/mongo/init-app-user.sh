#!/bin/sh
set -eu

mongosh --quiet \
  --host 127.0.0.1 \
  --username "$MONGO_INITDB_ROOT_USERNAME" \
  --password "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --eval "const databaseName = process.env.MONGODB_DATABASE; db = db.getSiblingDB(databaseName); db.createUser({ user: process.env.MONGO_APP_USERNAME, pwd: process.env.MONGO_APP_PASSWORD, roles: [{ role: 'readWrite', db: databaseName }] })"
