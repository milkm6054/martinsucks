# HCA Stats Runner

Standalone stats service for the HCA roster system.

It reads the tournament playerbase from the shared Postgres database, scrapes HLL Records for:
- `KPM` over `180d`
- `Duel strength` over `180d`

and stores the results back into shared stats tables.

## Environment

- `DATABASE_URL`: same Postgres database used by HCA Roster
- `BASIC_AUTH_USERNAME`: optional, protects the UI and API when set
- `BASIC_AUTH_PASSWORD`: optional, protects the UI and API when set
- `STATS_REQUESTED_BY`: optional label stored on each stats run
- `PYTHON_BIN`: optional Python executable override, defaults to trying `python3` then `python`
- `BROWSER_EXECUTABLE_PATH`: optional browser override, otherwise Playwright bundled Chromium is used on Linux

## Important

This repo is intended to share the same database as HCA Roster.
The stats tables are created by the migration in `prisma/migrations`.

## Railway notes

This service needs:
- Python available
- Python package `playwright`
- a browser runtime

The repo includes `nixpacks.toml` for Railway so Python, Playwright, and Chromium are installed during build.

The scraper uses a browser-backed Python script because HLL Records is blocking plain server-side requests.

## Railway

Use the repo as a Nixpacks deployment.

Expected start flow:

```bash
npx prisma migrate deploy && npm start
```

Expected default env additions:

```bash
PYTHON_BIN=python3
```
