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

## The dashboard

Deployed at **https://garmin-sync-75yx.onrender.com/** — one page with one
button. Open it, press **סנכרן**, and the service syncs the Garmin store. There
is nothing to configure and nothing to type: the store comes from `users.users`,
and the service address comes from wherever the page was served.

While a run is in flight the button shows its progress and the page polls; when
the run ends it shows the result. A failure shows the reason on the button
itself, and a `הצג יומן` link at the bottom opens the run log.

`garmin-dashboard.html` can also be opened straight from disk; it then points at
the deployed URL.

## API

The service finds the Garmin store itself, so no request has to identify it.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (used by the host's probe) |
| GET | `/api/garmin/config` | Which store and schedule the service is set to |
| GET | `/api/garmin/status` | Resolved store, state, progress, logs, last run |
| POST | `/api/garmin/sync` | What the button calls — starts in the background, answers immediately |

That leaves the endpoints open to anyone with the URL, and a run spends real
money on OpenAI and Gemini across the whole catalog. Setting **`SYNC_TOKEN`**
closes them behind a shared token, passed either as an `x-sync-token` header or
as `?token=` on the URL — so a bookmarked link keeps working as a
press-and-forget button. It is unset by default.

Pressing twice does not start two runs: the second call is refused with `409`.
There is no stop endpoint, because the underlying pipelines have no abort point
once a run starts.

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
| SYNC_TOKEN | Shared token required by the API when set; open when unset | No |
| GARMIN_CRON_SCHEDULE | Schedule (default: `0 2,14 * * *`) | No |
| GARMIN_CRON_TIMEZONE | Timezone (default: `UTC`) | No |
| ALLOWED_ORIGINS | Extra browser origins allowed to call the API | No |

## Worth knowing

If the Garmin store is marked `active: true`, the main service's own scheduled
sync already covers it, and this service adds two more refreshes a day on top.
The dashboard shows the store's `active` flag so that is visible. If the intent
is for this service to be the only thing syncing Garmin, the store should be
`active: false` in `users.users`.
