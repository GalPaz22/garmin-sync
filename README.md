# Garmin Sync Service

A standalone service that refreshes the catalog of **one store — Garmin** — on
its own twice-daily schedule, with a dashboard for updating on demand.

Garmin is a store, not a brand: it has its own document in the `users.users`
collection, registered under the name `garmin`. This service resolves that
document and works only on it.

It talks to the same MongoDB cluster as the main processing service and
authenticates against the same `users` collection, so the store's existing API
key works here unchanged. Onboarding, the all-stores sync and reprocessing stay
in the main service — this one does a single job.

## How a run works

1. Resolve the Garmin store from `users.users`.
2. Fetch its catalog from Shopify or WooCommerce, exactly as the main service
   does.
3. Enrich and upsert it through the same AI pipeline (translation,
   classification, embeddings).

Progress is written to a `garmin_sync_status` collection of its own, so this
service never overwrites the status of the main service's sync.

## Resolving the store

`GARMIN_STORE` (default `garmin`) is matched, case-insensitively, against a
store's `dbName`, `credentials.dbName`, `name`, `companyName` and `email`.

An **exact** match on any of those wins. Only when nothing matches exactly does
the lookup fall back to a partial match — otherwise a second account whose name
merely contains "garmin" could win and the wrong catalog would be synced. The
status endpoint reports which field matched, whether the match was exact, and
whether more than one account answered to the name, so a loose match is never
mistaken for a confident one. The dashboard shows all of it before you press
anything.

## Dashboard

Deployed at **https://garmin-sync-75yx.onrender.com/** — `GET /` (also
`GET /garmin`) serves a single self-contained page: the resolved store and its
storefront connection, the manual update button, live progress and the run log.

The service address is filled in automatically from wherever the page is served,
so nothing needs typing there. The one thing to supply is the Garmin store's API
key, which is the `apiKey` field on its document in `users.users`. It is kept in
the browser and sent to nothing but this service.

The store panel reports how the catalog will be fetched. For WooCommerce that is
either the REST API, when `wooKey` and `wooSecret` are both set on the store, or
a fallback to the public `/wp-json` endpoint when they are not — the fallback
returns a thinner catalog, so it is flagged rather than left to be discovered
from a short run.

`garmin-dashboard.html` can also be opened straight from disk; it then points at
the deployed URL.

## API

Both endpoints require an API key in the `x-api-key` header. Triggering an update
additionally requires that the key belong to the Garmin store itself, so another
store cannot drive this service.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (used by the host's probe) |
| GET | `/api/garmin/config` | Which store and schedule the service is set to |
| GET | `/api/garmin/status` | Resolved store, state, progress, logs, last run |
| POST | `/api/garmin/sync` | Manual update — starts in the background, answers immediately |

There is no stop endpoint: the underlying pipelines have no abort point, so a
run cannot be interrupted once it starts. A second request while a run is in
flight is refused with `409` rather than starting a competing run.

## Running locally

```bash
npm install
cp .env.example .env    # then fill in MONGODB_URI and the AI keys
npm start               # http://localhost:3001
npm test
```

## Deploying on Render

`render.yaml` describes the service: Node runtime, `npm install`, `npm start`,
health check on `/health`. Set `MONGODB_URI`, `OPENAI_API_KEY` and
`GOOGLE_AI_API_KEY` in the Render dashboard — they are marked `sync: false` so
their values are never committed.

**One thing to get right:** the twice-daily schedule runs inside this Node
process. On Render's free tier the service spins down when idle, and a scheduled
run that falls in a sleeping window simply never happens. Either run it on a paid
instance that stays up, or drop the internal schedule and drive it from a Render
Cron Job that calls `POST /api/garmin/sync` with the store's API key.

## Environment variables

| Variable | Description | Required |
|----------|-------------|----------|
| MONGODB_URI | MongoDB connection string | Yes |
| OPENAI_API_KEY | Used for embeddings | Yes |
| GOOGLE_AI_API_KEY | Used for translation and classification | Yes |
| PORT | Server port (default: 3001) | No |
| GARMIN_STORE | Store name in `users.users` (default: `garmin`) | No |
| GARMIN_CRON_SCHEDULE | Schedule (default: `0 2,14 * * *`) | No |
| GARMIN_CRON_TIMEZONE | Timezone (default: `UTC`) | No |
| ALLOWED_ORIGINS | Extra browser origins allowed to call the API | No |

## Worth knowing

If the Garmin store is marked `active: true`, the main service's own scheduled
sync already covers it, and this service adds two more refreshes a day on top.
The dashboard shows the store's `active` flag so that is visible. If the intent
is for this service to be the only thing syncing Garmin, the store should be
`active: false` in `users.users`.
