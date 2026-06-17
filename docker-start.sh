#!/bin/sh
set -eu

PORT_VALUE="${PORT:-3000}"

echo "Starting HCA Stats Runner"
echo "Using PORT=${PORT_VALUE}"
echo "Running Prisma migrations"
npx prisma migrate deploy

echo "Launching Next.js server"
exec npx next start -H 0.0.0.0 -p "${PORT_VALUE}"
