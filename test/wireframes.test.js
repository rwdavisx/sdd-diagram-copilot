const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProject, parseWireframeFlows, loadWireframes } = require('../server');

// ---------- parseWireframeFlows ----------

test('parses anchor, target, and kind from a tag', () => {
  const flows = parseWireframeFlows('<button id="go" data-flow-to="checkout" data-flow-kind="nav">Go</button>');
  assert.deepStrictEqual(flows, [{ anchor: 'go', to: 'checkout', kind: 'nav', label: null }]);
});

test('kind defaults to nav; missing id gives a null anchor', () => {
  const flows = parseWireframeFlows('<a data-flow-to="home">back</a>');
  assert.deepStrictEqual(flows, [{ anchor: null, to: 'home', kind: 'nav', label: null }]);
});

test('attribute order within the tag does not matter', () => {
  const flows = parseWireframeFlows('<form data-flow-kind="api" data-flow-to="orders-api" id="order-form" class="x">');
  assert.deepStrictEqual(flows, [{ anchor: 'order-form', to: 'orders-api', kind: 'api', label: null }]);
});

test('data-flow-label is captured', () => {
  const flows = parseWireframeFlows('<form id="f" data-flow-to="orders-api" data-flow-kind="api" data-flow-label="create order">');
  assert.deepStrictEqual(flows, [{ anchor: 'f', to: 'orders-api', kind: 'api', label: 'create order' }]);
});

test('finds multiple flow elements across a document', () => {
  const html = `<html><body>
    <button id="a" data-flow-to="x" data-flow-kind="nav">A</button>
    <div>plain</div>
    <table id="t" data-flow-to="y" data-flow-kind="data"></table>
  </body></html>`;
  assert.strictEqual(parseWireframeFlows(html).length, 2);
});

test('no flow attributes -> empty list', () => {
  assert.deepStrictEqual(parseWireframeFlows('<html><body><p>hi</p></body></html>'), []);
});

// ---------- loadProject wireframe detection + loadWireframes ----------

const YAML = `project: Test
items:
  - id: cart
    name: Cart
    type: frontend
    status: planned
  - id: checkout
    name: Checkout
    type: frontend
    status: planned
  - id: orders-api
    name: Orders API
    type: backend
    status: planned
`;

let dir, file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  file = path.join(dir, 'project.yaml');
  fs.writeFileSync(file, YAML);
  fs.mkdirSync(path.join(dir, 'design', 'wireframes'), { recursive: true });
});

const writeWf = (name, html) => fs.writeFileSync(path.join(dir, 'design', 'wireframes', name), html);

test('detects a convention-path wireframe; others stay null', () => {
  writeWf('cart.html', '<html></html>');
  const { items, errors } = loadProject(file);
  assert.strictEqual(items.find((i) => i.id === 'cart').wireframe, 'design/wireframes/cart.html');
  assert.strictEqual(items.find((i) => i.id === 'checkout').wireframe, null);
  assert.deepStrictEqual(errors, []);
});

test('declared wireframe that is missing on disk is an error and nulled', () => {
  fs.writeFileSync(file, YAML.replace('name: Cart', 'name: Cart\n    wireframe: design/other.html'));
  const { items, errors } = loadProject(file);
  assert.strictEqual(items.find((i) => i.id === 'cart').wireframe, null);
  assert.ok(errors.some((e) => e.includes('design/other.html')));
});

test('orphan wireframe file with no matching item is an error', () => {
  writeWf('ghost.html', '<html></html>');
  const { errors } = loadProject(file);
  assert.ok(errors.some((e) => e.includes('ghost.html')));
});

test('loadWireframes derives flows and drops dangling targets with an error', () => {
  writeWf('cart.html', `
    <button id="go" data-flow-to="checkout" data-flow-kind="nav">Go</button>
    <form id="f" data-flow-to="orders-api" data-flow-kind="api"></form>
    <a data-flow-to="nope">broken</a>`);
  const { items } = loadProject(file);
  const { flows, errors } = loadWireframes(dir, items);
  assert.deepStrictEqual(flows, [
    { from: 'cart', anchor: 'go', to: 'checkout', kind: 'nav', label: null },
    { from: 'cart', anchor: 'f', to: 'orders-api', kind: 'api', label: null },
  ]);
  assert.ok(errors.some((e) => e.includes('"nope"')));
});

// ---------- item-declared flows + contracts ----------

test('item-level flows merge in with defaults; bad targets error', () => {
  fs.writeFileSync(file, YAML.replace(
    'name: Orders API',
    'name: Orders API\n    flows:\n      - { to: cart, kind: data, label: order rows }\n      - { to: nope }\n      - { to: checkout }',
  ));
  const { items } = loadProject(file);
  const { flows, errors } = loadWireframes(dir, items);
  assert.deepStrictEqual(flows, [
    { from: 'orders-api', to: 'cart', kind: 'data', label: 'order rows', anchor: null },
    { from: 'orders-api', to: 'checkout', kind: 'data', label: null, anchor: null },
  ]);
  assert.ok(errors.some((e) => e.includes('"nope"')));
});

test('flows that are not a list error without crashing', () => {
  fs.writeFileSync(file, YAML.replace('name: Orders API', 'name: Orders API\n    flows: yes'));
  const { items } = loadProject(file);
  const { flows, errors } = loadWireframes(dir, items);
  assert.deepStrictEqual(flows, []);
  assert.ok(errors.some((e) => e.includes('flows must be a list')));
});

test('contracts validate: list shape and required name', () => {
  fs.writeFileSync(file, YAML.replace(
    'name: Orders API',
    'name: Orders API\n    contracts:\n      - name: POST /api/orders\n        kind: api\n      - kind: db',
  ));
  const { errors } = loadProject(file);
  assert.strictEqual(errors.filter((e) => e.includes('contract')).length, 1);
  assert.ok(errors.some((e) => e.includes('needs a name')));
});
