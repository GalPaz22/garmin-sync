import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// The `users.users` documents a lookup has to pick from.
const USERS = [
  { email: 'shop@polar.example', dbName: 'polar', platform: 'shopify', active: true },
  { email: 'info@garmin.co.il', dbName: 'garmin', name: 'garmin', platform: 'woocommerce', active: true, credentials: { wooUrl: 'https://garmin.example', dbName: 'garmin' } },
  { email: 'sales@garmin-accessories.example', dbName: 'garmin-accessories', platform: 'shopify', active: true }
];

const matchesQuery = (doc, query) => (query?.$or || []).some(clause => {
  const [path, regex] = Object.entries(clause)[0];
  const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), doc);
  return typeof value === 'string' && regex.test(value);
});

globalThis.__mongoStub = {
  db: () => ({
    collection: () => ({
      find: query => ({ toArray: async () => USERS.filter(doc => matchesQuery(doc, query)) })
    })
  })
};

register(pathToFileURL(new URL('./helpers/mongodbStubLoader.mjs', import.meta.url).pathname));

const { resolveGarminStore, resolveStoreConfig, describeMatch, describeConnection } = await import('../lib/garminStore.js');

test('an exact name match wins over a store that merely contains the name', () => {
  // "garmin-accessories" also contains "garmin"; picking it would sync the
  // wrong catalog, so the exact match has to be tried first.
  return resolveGarminStore('garmin').then(resolved => {
    assert.equal(resolved.user.dbName, 'garmin');
    assert.equal(resolved.match.exact, true);
    assert.ok(['dbName', 'credentials.dbName', 'name'].includes(resolved.match.field));
  });
});

test('a partial match is still found, and is reported as partial', async () => {
  const resolved = await resolveGarminStore('accessories');
  assert.equal(resolved.user.dbName, 'garmin-accessories');
  assert.equal(resolved.match.exact, false);
});

test('a name nobody answers to resolves to nothing rather than to a guess', async () => {
  assert.equal(await resolveGarminStore('suunto'), null);
});

test('an empty identifier is refused instead of matching every store', async () => {
  await assert.rejects(() => resolveGarminStore(''), /GARMIN_STORE/);
});

test('several accounts answering to the same name are surfaced, not silently dropped', async () => {
  const resolved = await resolveGarminStore('garmin');
  // The exact pass matches one document here; the loose pass would match both,
  // so ambiguity is reported only when the winning pass is itself ambiguous.
  assert.ok(Array.isArray(resolved.ambiguous));

  const loose = await resolveGarminStore('garm');
  assert.equal(loose.ambiguous.length, 2);
  assert.deepEqual(loose.ambiguous.map(entry => entry.dbName).sort(), ['garmin', 'garmin-accessories']);
});

test('the store config is read from wherever the record happens to keep it', () => {
  const config = resolveStoreConfig(USERS[1]);
  assert.equal(config.dbName, 'garmin');
  assert.equal(config.platform, 'woocommerce');
  assert.equal(config.credentials.wooUrl, 'https://garmin.example');

  // A record that only fills the nested shapes still resolves.
  const nested = resolveStoreConfig({
    email: 'x@y.z',
    onboarding: { credentials: { platform: 'shopify' }, dbName: 'nested-db' },
    configuration: { categories: { list: ['watches'] } }
  });
  assert.equal(nested.dbName, 'nested-db');
  assert.equal(nested.platform, 'shopify');
  assert.deepEqual(nested.categories, ['watches']);
});

test('the match description names the field a caller can verify against', () => {
  assert.equal(describeMatch({ dbName: 'garmin' }, 'garmin').field, 'dbName');
  assert.equal(describeMatch({ email: 'info@garmin.co.il' }, 'garmin').field, 'email');
  assert.equal(describeMatch({ email: 'info@garmin.co.il' }, 'garmin').exact, false);
  assert.equal(describeMatch({ dbName: 'polar' }, 'garmin').field, null);
});

test('the connection summary reports the woo mode a run will actually use', () => {
  const withKeys = describeConnection({
    platform: 'woocommerce',
    credentials: { wooUrl: 'https://garmin.co.il', wooKey: 'ck_live', wooSecret: 'cs_live' }
  });
  assert.equal(withKeys.url, 'https://garmin.co.il');
  assert.equal(withKeys.hasApiCredentials, true);
  assert.equal(withKeys.mode, 'woo-rest-api');

  // Without key and secret the pipeline silently falls back to the public
  // endpoint and returns a thinner catalog, so that has to be visible.
  const withoutKeys = describeConnection({
    platform: 'woocommerce',
    credentials: { wooUrl: 'https://garmin.co.il' }
  });
  assert.equal(withoutKeys.hasApiCredentials, false);
  assert.equal(withoutKeys.mode, 'woo-public-fallback');

  const missingUrl = describeConnection({ platform: 'woocommerce', credentials: {} });
  assert.equal(missingUrl.url, null);
});

test('the connection summary never carries a key or a secret', () => {
  const secrets = {
    wooKey: 'ck_SECRET_VALUE',
    wooSecret: 'cs_SECRET_VALUE',
    shopifyToken: 'shpat_SECRET_VALUE',
    shopifyClientSecret: 'shpss_SECRET_VALUE'
  };

  for (const platform of ['woocommerce', 'shopify', undefined]) {
    const serialized = JSON.stringify(describeConnection({
      platform,
      credentials: { ...secrets, wooUrl: 'https://garmin.co.il', shopifyDomain: 'garmin.myshopify.com' }
    }));
    // This object is sent to a browser; a leaked credential would be published.
    assert.doesNotMatch(serialized, /SECRET_VALUE/, `secret leaked for platform ${platform}`);
  }
});

test('shopify auth modes are distinguished, so a silent public fallback is visible', () => {
  assert.equal(describeConnection({ platform: 'shopify', credentials: { shopifyDomain: 'a.myshopify.com', shopifyClientId: 'id', shopifyClientSecret: 's' } }).mode, 'shopify-client-credentials');
  assert.equal(describeConnection({ platform: 'shopify', credentials: { shopifyDomain: 'a.myshopify.com', shopifyToken: 't' } }).mode, 'shopify-access-token');
  assert.equal(describeConnection({ platform: 'shopify', credentials: { shopifyDomain: 'a.myshopify.com' } }).mode, 'shopify-public-fallback');
});
