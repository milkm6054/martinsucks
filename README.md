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

## Important

This repo is intended to share the same database as HCA Roster.
The stats tables are created by the migration in `prisma/migrations`.

## Railway notes

This service also needs:
- Python available
- Python package `playwright`
- a Chrome or Edge browser installed in the runtime

The scraper uses a browser-backed Python script because HLL Records is blocking plain server-side requests.
