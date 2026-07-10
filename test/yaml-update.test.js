const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { updateProjectItem } = require('../server');

const YAML = `project: Test # keep me
items:
  - id: feat-a
    name: Feature A
    type: frontend
    status: planned
    notes: hands off

  - id: feat-b
    name: Feature B
    type: backend
    status: planned
`;

let file;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yu-')), 'project.yaml');
  fs.writeFileSync(file, YAML);
});

test('updates an existing field on the right item only', () => {
  assert.strictEqual(updateProjectItem(file, 'feat-a', { status: 'in-progress' }), true);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.items[0].status, 'in-progress');
  assert.strictEqual(doc.items[1].status, 'planned');
});

test('inserts a missing field at the end of the item block', () => {
  assert.strictEqual(updateProjectItem(file, 'feat-b', { spec: 'specs/feat-b.md' }), true);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.items[1].spec, 'specs/feat-b.md');
  assert.strictEqual(doc.items[0].spec, undefined);
});

test('preserves comments and untouched lines verbatim', () => {
  updateProjectItem(file, 'feat-a', { status: 'shipped' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# keep me/);
  assert.match(text, /notes: hands off/);
});

test('returns false for an unknown item and leaves the file alone', () => {
  assert.strictEqual(updateProjectItem(file, 'nope', { status: 'shipped' }), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), YAML);
});
