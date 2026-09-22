/**
 * The Garmin store sync.
 *
 * Reuses the main service's Shopify/WooCommerce pipelines unchanged — same
 * fetch, same AI enrichment, same catalog upsert. The only thing this service
 * adds is scope: one store, resolved from `users.users`, on its own schedule,
 * reporting progress to its own collection so it never overwrites the status of
 * the main service's sync.
 */

import clientPromise from './mongodb.js';
import processShopify from './processShopify.js';
import { processWooProducts } from './processWoo.js';
import { resolveGarminStore, resolveStoreConfig, describeConnection, STORE_IDENTIFIER } from './garminStore.js';

/** Status collection for Garmin runs, kept apart from the shared "sync_status". */
export const GARMIN_STATUS_COLLECTION = 'garmin_sync_status';

/** One run at a time, per process. */
let activeRun = null;

async function statusCollection(dbName) {
  const client = await clientPromise;
  return client.db(dbName).collection(GARMIN_STATUS_COLLECTION);
}

async function writeStatus(dbName, fields) {
  try {
    const collection = await statusCollection(dbName);
    await collection.updateOne(
      { dbName },
      { $set: { dbName, updatedAt: new Date(), ...fields } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`[GARMIN] Could not write status for ${dbName}: ${err.message}`);
  }
}

/** Is a run in flight right now? */
export function isGarminSyncRunning() {
  return activeRun !== null;
}

/**
 * Current state of the Garmin store and its last run.
 *
 * Both log locations are read: the Woo pipeline writes into the store's own
 * status document, while appendLogs (used by the Shopify one) writes into the
 * "users" database. Reading only one would show a run with no log at all.
 */
export async function getGarminStatus() {
  const resolved = await resolveGarminStore();

  if (!resolved) {
    return {
      storeIdentifier: STORE_IDENTIFIER,
      storeFound: false,
      state: 'unconfigured',
      running: false,
      logs: [],
      error: `No store named "${STORE_IDENTIFIER}" was found in users.users`
    };
  }

  const config = resolveStoreConfig(resolved.user);
  const client = await clientPromise;

  const [status, sharedStatus, productCount] = await Promise.all([
    config.dbName ? (await statusCollection(config.dbName)).findOne({ dbName: config.dbName }) : null,
    config.dbName
      ? client.db('users').collection(GARMIN_STATUS_COLLECTION).findOne({ dbName: config.dbName }).catch(() => null)
      : null,
    config.dbName
      ? client.db(config.dbName).collection('products').countDocuments({}).catch(() => null)
      : null
  ]);

  return {
    storeIdentifier: STORE_IDENTIFIER,
    storeFound: true,
    store: {
      email: config.email || null,
      dbName: config.dbName || null,
      platform: config.platform || null,
      active: resolved.user.active !== false,
      matchedField: resolved.match.field,
      matchedValue: resolved.match.value,
      exactMatch: resolved.match.exact,
      ambiguous: resolved.ambiguous,
      // Never carries key or secret values — see describeConnection.
      connection: describeConnection(config)
    },
    productCount,
    state: 'idle',
    progress: 0,
    done: 0,
    total: 0,
    ...(status || {}),
    logs: (status?.logs?.length ? status.logs : sharedStatus?.logs) || [],
    running: isGarminSyncRunning()
  };
}

/**
 * Can a run start at all?
 *
 * Resolving the store and checking it has what a sync needs happens before any
 * network call, so the button can be told "no store named garmin" straight
 * away instead of showing a run that appears to start and quietly never
 * happens. Anything that can only fail later — an unreachable storefront —
 * surfaces through the status document as usual.
 */
export async function checkGarminStore() {
  const resolved = await resolveGarminStore();
  if (!resolved) {
    return { ok: false, error: `No store named "${STORE_IDENTIFIER}" was found in users.users` };
  }

  const config = resolveStoreConfig(resolved.user);
  if (!config.dbName || !config.platform) {
    return {
      ok: false,
      error: `Store "${config.email || STORE_IDENTIFIER}" is missing ${!config.dbName ? 'dbName' : 'platform'}`
    };
  }

  return { ok: true, store: { dbName: config.dbName, email: config.email || null, platform: config.platform } };
}

/**
 * Run the sync for the Garmin store.
 * Never throws: a failure lands in the status document so the dashboard shows
 * what went wrong instead of a run that silently stops existing.
 */
export function runGarminSync({ triggeredBy = 'manual' } = {}) {
  // Claim the slot synchronously, before anything is awaited. Claiming after an
  // await leaves a window in which two presses both see an idle service and
  // both start a run over the same catalog.
  if (activeRun) {
    return Promise.resolve({ ok: false, skipped: true, error: 'A Garmin update is already running' });
  }
  const startedAt = new Date();
  activeRun = { startedAt, triggeredBy };

  return executeGarminRun({ triggeredBy, startedAt }).finally(() => { activeRun = null; });
}

/** The run itself. Only ever called with the slot already claimed. */
async function executeGarminRun({ triggeredBy, startedAt }) {
  const resolved = await resolveGarminStore();
  if (!resolved) {
    const error = `No store named "${STORE_IDENTIFIER}" was found in users.users`;
    console.error(`[GARMIN] ❌ ${error}`);
    return { ok: false, error };
  }

  const config = resolveStoreConfig(resolved.user);
  const { dbName, platform, email, credentials } = config;

  if (!dbName || !platform) {
    const error = `Store "${email || STORE_IDENTIFIER}" is missing ${!dbName ? 'dbName' : 'platform'}`;
    console.error(`[GARMIN] ❌ ${error}`);
    return { ok: false, error };
  }

  // appendLogs pushes without upserting, so the shared document has to exist
  // before the run starts or the Shopify pipeline's log lines go nowhere.
  try {
    const client = await clientPromise;
    await client.db('users').collection(GARMIN_STATUS_COLLECTION)
      .updateOne({ dbName }, { $set: { dbName, startedAt, logs: [] } }, { upsert: true });
  } catch (err) {
    console.error(`[GARMIN] Could not reset shared log for ${dbName}: ${err.message}`);
  }

  await writeStatus(dbName, {
    state: 'running',
    startedAt,
    finishedAt: null,
    lastError: null,
    triggeredBy,
    platform,
    storeEmail: email || null,
    logs: []
  });

  console.log(`[GARMIN] 🔄 Sync started for ${email || dbName} | db: ${dbName} | platform: ${platform} | trigger: ${triggeredBy}`);

  try {
    const shared = {
      dbName,
      categories: config.categories,
      softCategories: config.softCategories,
      colors: config.colors,
      statusCollectionName: GARMIN_STATUS_COLLECTION
    };

    if (platform === 'shopify') {
      const { shopifyDomain, shopifyToken, shopifyClientId, shopifyClientSecret } = credentials;
      if (!shopifyDomain) throw new Error('Missing Shopify domain');

      // Prefer the client-credentials flow, fall back to the legacy token, then
      // to the public products.json fetch inside the processor — the same order
      // the main service uses.
      const auth = shopifyClientId && shopifyClientSecret
        ? { shopifyDomain, shopifyClientId, shopifyClientSecret }
        : { shopifyDomain, ...(shopifyToken ? { shopifyToken } : {}) };

      await processShopify({ ...auth, ...shared, type: config.userTypes });

    } else if (platform === 'woocommerce') {
      const { wooUrl, wooKey, wooSecret } = credentials;
      if (!wooUrl) throw new Error('Missing WooCommerce URL');

      await processWooProducts({ wooUrl, wooKey, wooSecret, userEmail: email, ...shared, userTypes: config.userTypes });

    } else {
      throw new Error(`Unknown platform: ${platform}`);
    }

    const finishedAt = new Date();
    const client = await clientPromise;
    const productCount = await client.db(dbName).collection('products').countDocuments({}).catch(() => null);

    await writeStatus(dbName, { state: 'done', finishedAt, lastSuccessAt: finishedAt, productCount });

    console.log(`[GARMIN] ✅ Done for ${email || dbName} — ${productCount ?? '?'} products in catalog`);
    return { ok: true, dbName, email, productCount, durationMs: finishedAt - startedAt };

  } catch (err) {
    await writeStatus(dbName, { state: 'error', finishedAt: new Date(), lastError: err.message });
    console.error(`[GARMIN] ❌ Failed for ${email || dbName}: ${err.message}`);
    return { ok: false, dbName, email, error: err.message };
  }
}
