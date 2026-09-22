import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWooApi, resolveWooApiConstructor } from '../lib/shared/wooApi.js';

test('the installed WooCommerce package resolves to something constructable', () => {
  // The regression this guards: the package is CommonJS, so a default import
  // under "type": "module" yields its module.exports object rather than the
  // class, and `new` on it fails with "WooCommerceRestApi is not a constructor"
  // only once a live sync reaches the storefront.
  const Constructor = resolveWooApiConstructor();
  assert.equal(typeof Constructor, 'function');

  const api = createWooApi({
    url: 'https://store.example',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    version: 'wc/v3'
  });

  assert.equal(typeof api.get, 'function', 'a usable client exposes the REST verbs');
});

test('either export shape works, so an ESM build of the package would too', () => {
  const asClass = function Woo() {};
  assert.equal(resolveWooApiConstructor(asClass), asClass, 'a bare ESM default export');
  assert.equal(resolveWooApiConstructor({ default: asClass }), asClass, 'a Babel CJS namespace');
});

test('a package that exports no constructor says so instead of failing mid-sync', () => {
  assert.throws(() => resolveWooApiConstructor({ notAClass: true }), /did not export a constructor/);
});
