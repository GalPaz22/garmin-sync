/**
 * Garmin sync API.
 *
 * The service is for one store, so every route resolves that store from
 * `users.users` rather than from the caller. The API key still has to belong to
 * that same store, so another store's key cannot drive this service.
 */

import express from 'express';
import { runGarminSync, getGarminStatus, isGarminSyncRunning } from '../lib/garminSync.js';
import { resolveGarminStore, resolveStoreConfig, STORE_IDENTIFIER } from '../lib/garminStore.js';
import { GARMIN_CRON_SCHEDULE, GARMIN_CRON_TIMEZONE } from '../lib/garminCron.js';

const router = express.Router();

/**
 * The caller must be the Garmin store itself. Returns the resolved store, or
 * answers the request and returns null.
 */
async function requireGarminStore(req, res) {
  const resolved = await resolveGarminStore();

  if (!resolved) {
    res.status(404).json({
      error: `No store named "${STORE_IDENTIFIER}" was found in users.users`,
      details: 'Set GARMIN_STORE to the name the store is registered under.'
    });
    return null;
  }

  const config = resolveStoreConfig(resolved.user);
  const callerDbName = req.user?.dbName || req.user?.credentials?.dbName;

  if (!config.dbName || callerDbName !== config.dbName) {
    res.status(403).json({
      error: 'This API key does not belong to the Garmin store',
      details: `This service only updates "${STORE_IDENTIFIER}". Use that store's own API key.`
    });
    return null;
  }

  return { resolved, config };
}

/**
 * GET /api/garmin/config
 * What the service is set to do — shown in the dashboard header.
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
 * Which store was resolved and how, plus progress and logs for the dashboard's
 * polling. Any authenticated caller may read it, since it only reports.
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
 * The manual update button. Starts in the background and answers immediately,
 * because a full run is far longer than any browser will wait.
 */
router.post('/sync', async (req, res) => {
  try {
    if (isGarminSyncRunning()) {
      return res.status(409).json({ error: 'A Garmin update is already running', state: 'running' });
    }

    const target = await requireGarminStore(req, res);
    if (!target) return;

    const triggeredBy = req.user?.email || 'manual';
    console.log(`📊 [GARMIN] Manual update requested by ${triggeredBy} for ${target.config.dbName}`);

    runGarminSync({ triggeredBy })
      .then(result => console.log('[GARMIN] Manual run finished:', result))
      .catch(err => console.error('[GARMIN] Manual run crashed:', err));

    res.json({
      state: 'running',
      message: 'Garmin update started in the background',
      store: { dbName: target.config.dbName, email: target.config.email || null },
      triggeredBy,
      triggeredAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ [GARMIN] Sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
