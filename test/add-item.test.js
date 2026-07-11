const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { addProjectItem } = require('../server');

const YAML = `project: Test # keep me
items:
  - id: feat-a
    name: Feature A
    type: frontend
    status: planned
workflow:
  defaults: { model: sonnet }
`;

let file;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-')), 'project.yaml');
  fs.writeFileSync(file, YAML);
});

test('appends a planned item inside the items list, not after workflow:', () => {
  const r = addProjectItem(file, { name: 'PNG Export', type: 'frontend', notes: 'export: diagrams as "png"' });
  assert.strictEqual(r.id, 'png-export');
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.items.length, 2);
  assert.deepStrictEqual(doc.items[1], {
    id: 'png-export', name: 'PNG Export', type: 'frontend',
    status: 'planned', notes: 'export: diagrams as "png"',
  });
  assert.deepStrictEqual(doc.workflow, { defaults: { model: 'sonnet' } }); // untouched
  assert.match(fs.readFileSync(file, 'utf8'), /# keep me/); // comments preserved
});

test('suffixes the id on collision', () => {
  assert.strictEqual(addProjectItem(file, { name: 'Feat A!!', type: 'backend' }).id, 'feat-a-2');
  assert.strictEqual(addProjectItem(file, { name: 'feat a', type: 'backend' }).id, 'feat-a-3');
});

test('omits notes when blank', () => {
  addProjectItem(file, { name: 'Thing', type: 'backend', notes: '  ' });
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.items[1].notes, undefined);
});

test('handles an empty inline items list', () => {
  fs.writeFileSync(file, 'project: Empty\nitems: []\n');
  const r = addProjectItem(file, { name: 'First', type: 'frontend' });
  assert.strictEqual(r.id, 'first');
  assert.strictEqual(yaml.load(fs.readFileSync(file, 'utf8')).items[0].id, 'first');
});

test('rejects bad input and leaves the file alone', () => {
  assert.ok(addProjectItem(file, { name: '', type: 'frontend' }).error);
  assert.ok(addProjectItem(file, { name: 'x', type: 'db' }).error);
  assert.ok(addProjectItem(file, { name: '!!!', type: 'frontend' }).error);
  assert.ok(addProjectItem(file, {}).error);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), YAML);
});
