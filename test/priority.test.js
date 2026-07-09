// Run: node test/priority.test.js
const assert = require('assert');
const { computePriority } = require('../server.js');

const item = (id, status, depends, type = 'backend') =>
  ({ id, name: id, type, status, ...(depends ? { depends } : {}) });

// Mirrors example/project.yaml shape.
const fixture = [
  item('login-page', 'shipped', ['auth-api'], 'frontend'),
  item('product-list', 'in-progress', ['catalog-api'], 'frontend'),
  item('checkout-flow', 'planned', ['orders-api', 'payments'], 'frontend'),
  item('auth-api', 'shipped'),
  item('catalog-api', 'in-progress'),
  item('orders-api', 'planned', ['payments', 'email']),
  item('payments', 'planned', undefined, 'integration'),
  item('email', 'shipped', undefined, 'integration'),
];

{
  const { items, warnings } = computePriority(fixture);
  // shipped items excluded
  assert.ok(!items.some((i) => ['login-page', 'auth-api', 'email'].includes(i.id)));
  // ready first (payments unblocks 2 transitively, catalog-api 1), then topo order
  assert.deepStrictEqual(items.map((i) => i.id),
    ['payments', 'catalog-api', 'orders-api', 'checkout-flow', 'product-list']);
  assert.strictEqual(items[0].ready, true);
  assert.strictEqual(items[0].dependents, 2);
  assert.strictEqual(items[1].ready, true);
  // blockedBy lists only non-shipped deps
  const orders = items.find((i) => i.id === 'orders-api');
  assert.deepStrictEqual(orders.blockedBy, ['payments']);
  assert.strictEqual(orders.ready, false);
  assert.deepStrictEqual(warnings, []);
}

{
  // cycle: a <-> b flagged, appended after non-cycle items, one warning
  const { items, warnings } = computePriority([
    item('a', 'planned', ['b']),
    item('b', 'planned', ['a']),
    item('c', 'planned'),
  ]);
  assert.deepStrictEqual(items.map((i) => i.id), ['c', 'a', 'b']);
  assert.strictEqual(items[1].cycle, true);
  assert.strictEqual(items[2].cycle, true);
  assert.strictEqual(items[0].cycle, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('a') && warnings[0].includes('b'));
}

{
  // dangling dep does not block readiness
  const { items } = computePriority([item('a', 'planned', ['ghost'])]);
  assert.strictEqual(items[0].ready, true);
  assert.deepStrictEqual(items[0].blockedBy, []);
}

{
  // equal dependents count -> tie broken by id ascending
  const { items } = computePriority([
    item('bravo', 'planned'),
    item('alpha', 'planned'),
  ]);
  assert.deepStrictEqual(items.map((i) => i.id), ['alpha', 'bravo']);
}

console.log('priority tests: ok');
