/**
 * Garmin sync API.
 *
 * The service is for one store and finds it itself, in `users.users`, so no
 * caller has to identify the store or carry its API key — the dashboard is a
 * single button.
 *
 * That leaves the endpoints open by default. A run costs real money (it calls
 * OpenAI and Gemini across the whole catalog), so setting SYNC_TOKEN closes
 * them behind a shared token without changing anything about how the button
 * works for whoever has the link.
 */

import express from 'express';
import { runGarminSync, getGarminStatus, isGarminSyncRunning, checkGarminStore } from '../lib/garminSync.js';
import { STORE_IDENTIFIER } from '../lib/garminStore.js';
import { GARMIN_CRON_SCHEDULE, GARMIN_CRON_TIMEZONE } from '../lib/garminCron.js';

const router = express.Router();

const SYNC_TOKEN = (process.env.SYNC_TOKEN || '').trim();

/**
 * Open unless SYNC_TOKEN is set, in which case every call carries it — as the
 * `x-sync-token` header, or as `?token=` so a plain link still works.
 */
router.use((req, res, next) => {
  if (!SYNC_TOKEN) return next();

  const provided = req.headers['x-sync-token'] || req.query.token;
  if (provided === SYNC_TOKEN) return next();

  return res.status(401).json({ error: 'Missing or invalid sync token' });
});

/**
 * GET /api/garmin/config
 * What the service is set to do — shown under the button.
 */
router.get('/config', (req, res) => {
  res.json({
    storeIdentifier: STORE_IDENTIFIER,
    schedule: GARMIN_CRON_SCHEDULE,
    timezone: GARMIN_CRON_TIMEZONE,
    runsPerDay: 2
  });
});

/**
 * GET /api/garmin/status
 * Which store was resolved, whether a run is in flight, and the last result.
 */
router.get('/status', async (req, res) => {
  try {
    const status = await getGarminStatus();
    res.json({
      ...status,
      logs: Array.isArray(status.logs) ? status.logs.slice(-200) : [],
      schedule: GARMIN_CRON_SCHEDULE,
      timezone: GARMIN_CRON_TIMEZONE
    });
  } catch (error) {
    console.error('❌ [GARMIN] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/garmin/sync
 * The button. Resolves the Garmin store itself, starts in the background and
 * answers immediately, because a full run is far longer than a browser waits.
 */
router.post('/sync', async (req, res) => {
  try {
    if (isGarminSyncRunning()) {
      return res.status(409).json({ error: 'A Garmin update is already running', state: 'running' });
    }

    // Anything that can be known before the run starts is answered now, so a
    // misconfigured store shows on the button instead of as a run that appears
    // to start and quietly never happens.
    const check = await checkGarminStore();
    if (!check.ok) return res.status(400).json({ state: 'error', error: check.error });

    const triggeredBy = req.headers['x-triggered-by'] || 'dashboard';
    console.log(`📊 [GARMIN] Manual update requested (${triggeredBy}) for ${check.store.dbName}`);

    runGarminSync({ triggeredBy })
      .then(result => console.log('[GARMIN] Manual run finished:', result))
      .catch(err => console.error('[GARMIN] Manual run crashed:', err));

    res.json({
      state: 'running',
      message: 'Garmin update started in the background',
      store: check.store,
      triggeredAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ [GARMIN] Sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
