/**
 * Twice-daily schedule for the Garmin store sync.
 *
 * Separate from the main service's schedule on purpose: that one keeps running
 * on its own cadence and is not affected by anything here.
 */

import cron from 'node-cron';
import { runGarminSync } from './garminSync.js';

// Two runs a day, twelve hours apart, away from the top-of-day hours where the
// main service's sync and daily agent already compete for the same APIs.
const DEFAULT_SCHEDULE = '0 2,14 * * *';
const DEFAULT_TIMEZONE = 'UTC';

export const GARMIN_CRON_SCHEDULE = process.env.GARMIN_CRON_SCHEDULE || DEFAULT_SCHEDULE;
export const GARMIN_CRON_TIMEZONE = process.env.GARMIN_CRON_TIMEZONE || DEFAULT_TIMEZONE;

let scheduledTask = null;

export function startGarminCron() {
  if (scheduledTask) return scheduledTask;

  if (!cron.validate(GARMIN_CRON_SCHEDULE)) {
    console.error(`[GARMIN CRON] ✗ Invalid schedule "${GARMIN_CRON_SCHEDULE}" — Garmin sync is NOT scheduled`);
    return null;
  }

  scheduledTask = cron.schedule(GARMIN_CRON_SCHEDULE, async () => {
    try {
      await runGarminSync({ triggeredBy: 'cron' });
    } catch (err) {
      console.error(`[GARMIN CRON] ❌ Scheduled run failed: ${err.message}`);
    }
  }, { timezone: GARMIN_CRON_TIMEZONE });

  console.log(`[GARMIN CRON] ⏰ Garmin sync scheduled — "${GARMIN_CRON_SCHEDULE}" (${GARMIN_CRON_TIMEZONE}), twice a day`);
  return scheduledTask;
}

export default startGarminCron;
