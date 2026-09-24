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

test('a breadcrumb carrying Neuro or Vibey hides the product', async () => {
  const { __test__ } = await import('../lib/processWoo.js');
  const build = __test__.createBasicProductData;

  const neuro = build({ id: 20, name: 'Watch', status: 'publish', categories: [{ name: 'Neuro', slug: 'neuro' }] });
  assert.equal(neuro.hidden, true);
  assert.equal(neuro.hiddenReason, 'breadcrumb:Neuro');

  // A Hebrew category name usually still carries a latin slug, and the phrases
  // being matched are latin — so the slug counts as breadcrumb text too.
  const vibey = build({ id: 21, name: 'Band', status: 'publish', categories: [{ name: 'שעונים', slug: 'vibey-collection' }] });
  assert.equal(vibey.hidden, true);
  assert.equal(vibey.hiddenReason, 'breadcrumb:Vibey');

  // Case must not decide it, and a nested crumb must be reached.
  assert.equal(build({ id: 22, name: 'X', status: 'publish', categories: [{ name: 'Home' }, { name: 'NEURO GEAR' }] }).hidden, true);
});

test('an unrelated breadcrumb leaves the product visible', async () => {
  const { __test__ } = await import('../lib/processWoo.js');
  const build = __test__.createBasicProductData;

  const visible = build({ id: 23, name: 'Fenix', status: 'publish', categories: [{ name: 'Watches', slug: 'watches' }] });
  assert.equal(visible.hidden, false);
  assert.equal(visible.hiddenReason, null);

  assert.equal(build({ id: 24, name: 'Edge', status: 'publish' }).hidden, false, 'no categories at all');
});

test('draft still wins the reason when both rules apply', async () => {
  const { __test__ } = await import('../lib/processWoo.js');
  const build = __test__.createBasicProductData;

  const both = build({ id: 25, name: 'X', status: 'draft', categories: [{ name: 'Neuro' }] });
  assert.equal(both.hidden, true);
  assert.equal(both.hiddenReason, 'draft');
});

test('the breadcrumb is read from the raw payload the public fallbacks keep', async () => {
  const { resolveWooBreadcrumb, matchHiddenBreadcrumbTerm } = await import('../lib/shared/wooPublicProducts.js');

  // The wp/v2 fallback empties `categories` and keeps the original under
  // publicProductJson, so a breadcrumb must survive that normalisation.
  const product = { categories: [], publicProductJson: { categories: [{ name: 'Vibey' }] } };
  assert.match(resolveWooBreadcrumb(product), /Vibey/);
  assert.equal(matchHiddenBreadcrumbTerm(product), 'Vibey');

  // An explicit breadcrumb trail, whichever shape it arrives in.
  assert.equal(matchHiddenBreadcrumbTerm({ breadcrumbs: ['Home', 'Neuro', 'Watches'] }), 'Neuro');
  assert.equal(matchHiddenBreadcrumbTerm({ breadcrumb: 'Home / Vibey / Bands' }), 'Vibey');
});
