import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWooDraft, resolveWooProductStatus } from '../lib/shared/wooPublicProducts.js';

test('a draft is recognised from the REST shape and from the public fallback', () => {
  assert.equal(resolveWooProductStatus({ status: 'draft' }), 'draft');
  // The public fallbacks normalise status away but keep the raw payload.
  assert.equal(resolveWooProductStatus({ publicProductJson: { status: 'draft' } }), 'draft');
  assert.equal(resolveWooProductStatus({ status: 'DRAFT' }), 'draft', 'case must not decide it');

  assert.equal(isWooDraft({ status: 'draft' }), true);
  assert.equal(isWooDraft({ status: 'publish' }), false);
});

test('an unknown status is never treated as a draft', () => {
  // `active: false` covers pending and private too, so it cannot stand in for
  // "draft" — hiding a live product on a guess is the worse failure.
  assert.equal(resolveWooProductStatus({ active: false }), null);
  assert.equal(isWooDraft({ active: false }), false);
  assert.equal(isWooDraft({}), false);
  assert.equal(isWooDraft({ status: '   ' }), false);
});

test('hidden is written on every product, not only on drafts', async () => {
  const { __test__ } = await import('../lib/processWoo.js');
  const build = __test__.createBasicProductData;

  assert.equal(build({ id: 1, name: 'Forerunner', status: 'draft' }).hidden, true);
  assert.equal(build({ id: 2, name: 'Fenix', status: 'publish' }).hidden, false);

  // The reason for the flag stays on the document.
  assert.equal(build({ id: 1, name: 'Forerunner', status: 'draft' }).status, 'draft');

  // A flag that were only ever set to true would survive the product being
  // published and hide it for good, so the false case is the one that matters.
  assert.equal(build({ id: 3, name: 'Edge' }).hidden, false);
});
