import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import express from 'express';

const GARMIN_USER = {
  email: 'info@garmin.co.il',
  dbName: 'garmin',
  name: 'garmin',
  platform: 'woocommerce',
  active: true,
  credentials: { wooUrl: 'https://garmin.example', dbName: 'garmin' }
};
const OTHER_USER = { email: 'shop@polar.example', dbName: 'polar', platform: 'shopify', active: true };

const statusDocs = new Map();
const PRODUCT_COUNT = 412;

const matchesQuery = (doc, query) => (query?.$or || []).some(clause => {
  const [path, regex] = Object.entries(clause)[0];
  const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), doc);
  return typeof value === 'string' && regex.test(value);
});

globalThis.__mongoStub = {
  db: () => ({
    collection: name => name === 'products'
      ? { countDocuments: async () => PRODUCT_COUNT }
      : {
          find: query => ({ toArray: async () => [GARMIN_USER, OTHER_USER].filter(doc => matchesQuery(doc, query)) }),
          findOne: async query => statusDocs.get(query?.dbName) || null,
          updateOne: async (query, { $set }) => {
            statusDocs.set(query.dbName, { ...(statusDocs.get(query.dbName) || {}), ...$set });
            return { acknowledged: true };
          }
        }
  })
};

register(pathToFileURL(new URL('./helpers/mongodbStubLoader.mjs', import.meta.url).pathname));

let server;
let baseUrl;

before(async () => {
  const garminRouter = (await import('../routes/garmin.js')).default;
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts it: no caller identity at all.
  app.use('/api/garmin', garminRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const call = async (path, options) => {
  const response = await fetch(baseUrl + path, options);
  return { status: response.status, body: await response.json() };
};

test('the service reports which store and schedule it is configured for', async () => {
  const { status, body } = await call('/api/garmin/config');
  assert.equal(status, 200);
  assert.equal(body.storeIdentifier, 'garmin');
  assert.equal(body.runsPerDay, 2);
});

test('status names the store it resolved and how it matched', async () => {
  const { status, body } = await call('/api/garmin/status');
  assert.equal(status, 200);
  assert.equal(body.storeFound, true);
  assert.equal(body.store.dbName, 'garmin');
  assert.equal(body.store.platform, 'woocommerce');
  assert.equal(body.store.exactMatch, true);
  assert.ok(body.store.matchedField, 'the caller must be able to verify the match');
  assert.equal(body.productCount, PRODUCT_COUNT);
  assert.equal(body.running, false);
});

test('the button needs nothing from the caller to sync the right store', async () => {
  // No key, no store name, no body — the service finds Garmin in users.users.
  const { status, body } = await call('/api/garmin/sync', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(body.state, 'running');
});

test('a second press while a run is in flight does not start a competing run', async () => {
  // Driven through the library, not HTTP, so the assertion does not depend on
  // the first run still being in flight when the second request lands.
  const { runGarminSync, isGarminSyncRunning } = await import('../lib/garminSync.js');

  const first = runGarminSync({ triggeredBy: 'test' });
  // The slot must be claimed synchronously: claiming after an await would let
  // two presses both see an idle service and both start.
  assert.equal(isGarminSyncRunning(), true, 'the slot must be claimed before any await');

  const second = await runGarminSync({ triggeredBy: 'test' });
  assert.equal(second.skipped, true);
  assert.match(second.error, /already running/);

  await first;
  assert.equal(isGarminSyncRunning(), false, 'the slot must be released when the run ends');
});

test('a failed run settles into an error state instead of staying "running"', async () => {
  // The run started above reaches a WooCommerce URL that does not exist here,
  // so it must land in `error` and release the run slot.
  const deadline = Date.now() + 8000;
  let body;
  do {
    await new Promise(resolve => setTimeout(resolve, 250));
    ({ body } = await call('/api/garmin/status'));
  } while (body.running && Date.now() < deadline);

  assert.equal(body.running, false, 'the run slot must be released');
  assert.ok(['error', 'done'].includes(body.state), `expected a settled state, got ${body.state}`);
});
