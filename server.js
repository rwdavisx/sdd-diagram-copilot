#!/usr/bin/env node
// diagram-copilot server: serves a project.yaml as JSON, spec markdown, and
// SSE reload events, plus the built viewer from web/dist.
// Usage: node server.js <path-to-project.yaml> [--port 4400]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');
const { createWorkflow, STEPS } = require('./workflow');
const { startSession } = require('./sessions');
const { createGraphify } = require('./graphify');

const TYPES = ['frontend', 'backend', 'integration'];
const STATUSES = ['planned', 'in-progress', 'shipped'];
const TEST_STATUSES = ['passing', 'failing', 'unknown'];

function parseArgs(argv) {
  const args = { port: 4400, yamlPath: null, open: true, init: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'init') args.init = true;
    else if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--no-open') args.open = false;
    else if (!args.yamlPath) args.yamlPath = a;
  }
  // Default: the project.yaml in the current directory, so `diagram-copilot`
  // dropped into any repo just works.
  if (!args.yamlPath) args.yamlPath = 'project.yaml';
  if (!Number.isInteger(args.port)) {
    console.error('Usage: diagram-copilot [init] [path-to-project.yaml] [--port 4400] [--no-open]');
    process.exit(1);
  }
  args.yamlPath = path.resolve(args.yamlPath);
  return args;
}

// Scaffold a repo for spec-driven development: a starter project.yaml, the
// agent guide (AGENTS.md) that teaches Claude the schema and rules, and a
// .gitignore entry for runtime workflow state. Idempotent.
function initProject(yamlPath) {
  const dir = path.dirname(yamlPath);
  const made = [];
  if (!fs.existsSync(yamlPath)) {
    fs.writeFileSync(yamlPath, `project: ${path.basename(dir)}\nitems: []\n`);
    made.push(path.basename(yamlPath));
  }
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fs.copyFileSync(path.join(__dirname, 'AGENTS.md'), agentsPath);
    made.push('AGENTS.md');
  }
  const giPath = path.join(dir, '.gitignore');
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  if (!gi.split('\n').some((l) => l.trim() === '.superpowers/')) {
    fs.writeFileSync(giPath, `${gi.replace(/\n?$/, '\n')}.superpowers/\n`);
    made.push('.gitignore (.superpowers/ entry)');
  }
  console.log(made.length ? `Initialized: ${made.join(', ')}` : 'Already initialized — nothing to do.');
  console.log('Open the dashboard\'s Design tab: "Plan project" to plan something new, or "Analyze codebase" to reverse-engineer an existing repo into the blueprint.');
}

function loadProject(yamlPath) {
  const errors = [];
  let doc = null;
  try {
    doc = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
  } catch (e) {
    return { project: null, items: [], errors: [`Failed to read/parse ${yamlPath}: ${e.message}`] };
  }
  if (!doc || typeof doc !== 'object') {
    return { project: null, items: [], errors: ['YAML file is empty or not a mapping'] };
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  if (!Array.isArray(doc.items)) errors.push('`items` is missing or not a list');

  const ids = new Set();
  for (const item of items) {
    const label = item && item.id ? `"${item.id}"` : JSON.stringify(item);
    if (!item || typeof item !== 'object') { errors.push(`Item ${label} is not a mapping`); continue; }
    if (!item.id) errors.push(`Item ${label} is missing an id`);
    else if (ids.has(item.id)) errors.push(`Duplicate id ${label}`);
    else ids.add(item.id);
    if (!item.name) errors.push(`Item ${label} is missing a name`);
    if (!TYPES.includes(item.type)) errors.push(`Item ${label} has unknown type "${item.type}" (expected ${TYPES.join(' | ')})`);
    if (!STATUSES.includes(item.status)) errors.push(`Item ${label} has unknown status "${item.status}" (expected ${STATUSES.join(' | ')})`);
    if (item.depends != null && !Array.isArray(item.depends)) errors.push(`Item ${label}: depends must be a list of ids`);
    if (item.contracts != null) {
      if (!Array.isArray(item.contracts)) errors.push(`Item ${label}: contracts must be a list`);
      else for (const c of item.contracts) {
        if (!c || typeof c !== 'object' || !c.name) errors.push(`Item ${label}: each contract needs a name`);
      }
    }
    if (item.tests != null) {
      if (!Array.isArray(item.tests)) errors.push(`Item ${label}: tests must be a list`);
      else for (const t of item.tests) {
        if (!t || typeof t !== 'object' || !t.name) { errors.push(`Item ${label}: each test needs a name`); continue; }
        if (t.status == null) t.status = 'unknown';
        else if (!TEST_STATUSES.includes(t.status)) {
          errors.push(`Item ${label}: test "${t.name}" has unknown status "${t.status}" (expected ${TEST_STATUSES.join(' | ')})`);
        }
      }
    }
  }
  for (const item of items) {
    if (!item || !Array.isArray(item.depends)) continue;
    for (const dep of item.depends) {
      if (!ids.has(dep)) errors.push(`Item "${item.id}" depends on unknown id "${dep}"`);
    }
  }
  // Wireframes: declared via `wireframe:` or by convention at
  // design/wireframes/<id>.html. Resolved to the path if present, else null.
  const dir = path.dirname(yamlPath);
  const declared = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    if (item.wireframe) {
      declared.add(path.posix.normalize(String(item.wireframe).replace(/\\/g, '/')));
      if (!fs.existsSync(path.resolve(dir, item.wireframe))) {
        errors.push(`Item "${item.id}" declares wireframe "${item.wireframe}" but the file does not exist`);
        item.wireframe = null;
      }
    } else {
      const conv = `design/wireframes/${item.id}.html`;
      item.wireframe = fs.existsSync(path.join(dir, 'design', 'wireframes', `${item.id}.html`)) ? conv : null;
    }
    // Per-file revision so the viewer only reloads iframes whose file changed.
    if (item.wireframe) {
      try { item.wfrev = Math.round(fs.statSync(path.resolve(dir, item.wireframe)).mtimeMs); } catch { item.wfrev = 0; }
    }
  }
  const wfDir = path.join(dir, 'design', 'wireframes');
  if (fs.existsSync(wfDir)) {
    for (const f of fs.readdirSync(wfDir)) {
      if (!f.endsWith('.html')) continue;
      if (!ids.has(f.slice(0, -5)) && !declared.has(`design/wireframes/${f}`)) {
        errors.push(`Wireframe design/wireframes/${f} has no matching item`);
      }
    }
  }
  // Optional per-step session config: workflow.defaults / workflow.steps.<id>,
  // each { model, effort }; items may also carry their own `workflow:` override.
  let workflow = null;
  if (doc.workflow != null) {
    if (typeof doc.workflow === 'object' && !Array.isArray(doc.workflow)) workflow = doc.workflow;
    else errors.push('`workflow` must be a mapping ({ defaults, steps })');
  }
  return { project: doc.project || path.basename(path.dirname(yamlPath)), items, workflow, errors };
}

// Element-anchored flows are declared inside the wireframe HTML itself:
// data-flow-to="<item-id>" (target), data-flow-kind="nav|api|data" (default
// nav), data-flow-label="…" (optional edge label), and the element's id= as
// the edge anchor (null → node default handle).
function parseWireframeFlows(html) {
  const flows = [];
  const tagRe = /<[a-z][a-z0-9-]*(?:\s[^<>]*)?\bdata-flow-to="([^"]+)"[^<>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const kind = (/\bdata-flow-kind="(nav|api|data)"/i.exec(tag) || [])[1] || 'nav';
    const anchor = (/\bid="([^"]+)"/i.exec(tag) || [])[1] || null;
    const label = (/\bdata-flow-label="([^"]+)"/i.exec(tag) || [])[1] || null;
    flows.push({ anchor, to: m[1], kind: kind.toLowerCase(), label });
  }
  return flows;
}

// Parse every item's wireframe for flows; flows to unknown ids are dropped
// with an error so the diagram never renders a dangling edge.
function loadWireframes(dir, items) {
  const flows = [];
  const errors = [];
  const ids = new Set(items.filter((i) => i && i.id).map((i) => i.id));
  for (const item of items) {
    if (!item || !item.id || !item.wireframe) continue;
    let html;
    try { html = fs.readFileSync(path.resolve(dir, item.wireframe), 'utf8'); } catch { continue; }
    for (const f of parseWireframeFlows(html)) {
      if (!ids.has(f.to)) {
        errors.push(`Wireframe ${item.wireframe}: data-flow-to unknown id "${f.to}"`);
        continue;
      }
      if (f.to !== item.id) flows.push({ from: item.id, ...f });
    }
  }
  // Item-declared flows (project.yaml `flows:`) — the way backend and
  // integration items, which have no wireframe, express data movement.
  const FLOW_KINDS = ['nav', 'api', 'data'];
  for (const item of items) {
    if (!item || !item.id || item.flows == null) continue;
    if (!Array.isArray(item.flows)) { errors.push(`Item "${item.id}": flows must be a list`); continue; }
    for (const f of item.flows) {
      if (!f || typeof f !== 'object' || !f.to) { errors.push(`Item "${item.id}": each flow needs a \`to\` id`); continue; }
      if (!ids.has(f.to)) { errors.push(`Item "${item.id}": flow to unknown id "${f.to}"`); continue; }
      if (f.to === item.id) continue;
      flows.push({
        from: item.id,
        to: f.to,
        kind: FLOW_KINDS.includes(f.kind) ? f.kind : 'data',
        label: f.label || null,
        anchor: null,
      });
    }
  }
  return { flows, errors };
}

// Priority order for non-shipped items: ready items (all depends shipped)
// first, ranked by how much downstream work they unblock, then blocked items
// in dependency order. Cycles are flagged, not fatal.
function computePriority(items) {
  const valid = items.filter((i) => i && typeof i === 'object' && i.id);
  const pendingIds = new Set(valid.filter((i) => i.status !== 'shipped').map((i) => i.id));
  const pending = valid.filter((i) => pendingIds.has(i.id));

  // Deps that block: exist and aren't shipped (dangling ids are reported by loadProject).
  const blockers = (item) =>
    (Array.isArray(item.depends) ? item.depends : []).filter((d) => pendingIds.has(d));

  // Transitive pending dependents: finishing this item helps that many others.
  const dependents = new Map();
  for (const item of pending) {
    const seen = new Set();
    const stack = [item.id];
    while (stack.length) {
      const cur = stack.pop();
      for (const other of pending) {
        if (!seen.has(other.id) && blockers(other).includes(cur)) {
          seen.add(other.id);
          stack.push(other.id);
        }
      }
    }
    dependents.set(item.id, seen.size);
  }

  const byRank = (a, b) =>
    dependents.get(b.id) - dependents.get(a.id) || a.id.localeCompare(b.id);

  // Ready items first, then Kahn's algorithm over the blocked ones.
  // ponytail: O(n^3) worst case (dependents BFS + frontier rescan); fine for hand-edited project files.
  const ready = pending.filter((i) => blockers(i).length === 0).sort(byRank);
  const done = new Set(ready.map((i) => i.id));
  const ordered = [...ready];
  while (ordered.length < pending.length) {
    const frontier = pending
      .filter((i) => !done.has(i.id) && blockers(i).every((d) => done.has(d)))
      .sort(byRank);
    if (frontier.length === 0) break; // the rest are in a cycle
    done.add(frontier[0].id);
    ordered.push(frontier[0]);
  }
  const inCycle = pending
    .filter((i) => !done.has(i.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const toEntry = (i, cycle) => ({
    id: i.id, name: i.name, type: i.type, status: i.status, spec: i.spec || null,
    ready: blockers(i).length === 0,
    blockedBy: blockers(i),
    dependents: dependents.get(i.id),
    ...(cycle ? { cycle: true } : {}),
  });
  return {
    items: [...ordered.map((i) => toEntry(i, false)), ...inCycle.map((i) => toEntry(i, true))],
    warnings: inCycle.length
      ? [`Dependency cycle involving: ${inCycle.map((i) => i.id).join(', ')}`]
      : [],
  };
}

// Set scalar fields on one item in project.yaml with a line-targeted edit,
// preserving comments/formatting everywhere else (a yaml round-trip would
// destroy them). This is how workflow state lands in the yaml automatically
// instead of relying on a session remembering to do it.
function updateProjectItem(yamlPath, itemId, fields) {
  let text;
  try { text = fs.readFileSync(yamlPath, 'utf8'); } catch { return false; }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s+id:\\s*${itemId}\\s*$`).test(l));
  if (start === -1) return false;
  const indent = lines[start].match(/^\s*/)[0] + '  ';
  let end = lines.length; // item block ends at the next list entry or top-level key
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s/.test(lines[i]) || /^\S/.test(lines[i])) { end = i; break; }
  }
  for (const [key, value] of Object.entries(fields)) {
    const at = lines.slice(start + 1, end).findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
    if (at !== -1) lines[start + 1 + at] = `${indent}${key}: ${value}`;
    else lines.splice(end++, 0, `${indent}${key}: ${value}`);
  }
  fs.writeFileSync(yamlPath, lines.join('\n'));
  return true;
}

const ITEM_TYPES = ['frontend', 'backend', 'integration'];

// Append a new planned item at the end of the `items:` list with a
// line-targeted edit (comment-preserving, like updateProjectItem above).
// Returns { id } on success or { error } on invalid input.
function addProjectItem(yamlPath, { name, type, notes } = {}) {
  name = String(name || '').trim();
  if (!name) return { error: 'name required' };
  if (!ITEM_TYPES.includes(type)) return { error: `type must be one of: ${ITEM_TYPES.join(', ')}` };
  let text;
  try { text = fs.readFileSync(yamlPath, 'utf8'); } catch { return { error: `Cannot read ${yamlPath}` }; }
  const lines = text.split('\n');
  const itemsAt = lines.findIndex((l) => /^items:/.test(l));
  if (itemsAt === -1) return { error: 'project.yaml has no items: list' };

  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return { error: 'name must contain letters or numbers' };
  const ids = new Set();
  for (const l of lines) {
    const m = l.match(/^\s*-\s+id:\s*(\S+)/);
    if (m) ids.add(m[1]);
  }
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;

  notes = String(notes || '').trim();
  const block = [
    `  - id: ${id}`,
    `    name: ${JSON.stringify(name)}`,
    `    type: ${type}`,
    '    status: planned',
    ...(notes ? [`    notes: ${JSON.stringify(notes)}`] : []),
  ];
  // End of the items list = the next top-level key, else EOF; back up over
  // trailing blank lines so the block lands inside the list.
  let end = lines.length;
  for (let i = itemsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  while (end > itemsAt + 1 && lines[end - 1].trim() === '') end--;
  if (/^items:\s*\[\s*\]\s*$/.test(lines[itemsAt])) lines[itemsAt] = 'items:';
  lines.splice(end, 0, ...block);
  fs.writeFileSync(yamlPath, lines.join('\n'));
  return { id };
}

// Plan progress for an item: read docs/superpowers/plans/<id>.md — from the
// active worktree while the item is mid-pipeline (the plan lives on the
// branch until merge), else the project dir — and count markdown checkboxes.
function planInfo(projectDir, wfState, item) {
  const dirs = [];
  if (wfState && wfState.itemId === item.id && wfState.worktreePath) dirs.push(wfState.worktreePath);
  dirs.push(projectDir);
  for (const d of dirs) {
    let text;
    try { text = fs.readFileSync(path.join(d, 'docs', 'superpowers', 'plans', `${item.id}.md`), 'utf8'); } catch { continue; }
    const tasks = (text.match(/^\s*[-*] \[[ xX]\]/gm) || []).length;
    const done = (text.match(/^\s*[-*] \[[xX]\]/gm) || []).length;
    return { tasks, done };
  }
  return null;
}

// Rejects cross-origin POSTs (LAN/CSRF) while allowing same-origin and
// no-Origin requests (curl, same-origin fetches that omit it).
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(new Error('Body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) initProject(args.yamlPath);
  if (!fs.existsSync(args.yamlPath)) {
    console.error(`${args.yamlPath} not found — run \`diagram-copilot init\` in your repo first.`);
    process.exit(1);
  }
  const projectDir = path.dirname(args.yamlPath);
  const distDir = path.join(__dirname, 'web', 'dist');
  const sseClients = new Set();

  const graphify = createGraphify();
  // Graphify is a required dependency: block startup until the CLI resolves
  // (bootstrapping uv if needed) and refuse to serve without it. The graph
  // itself still generates in the background.
  if (!await graphify.ensureInstalled()) {
    console.error('graphify is required to run diagram-copilot. ' + graphify.installHint);
    process.exit(1);
  }
  graphify.ensureGraphFresh(projectDir);

  const workflow = createWorkflow({
    projectDir,
    loadItems: () => loadProject(args.yamlPath).items,
    loadWorkflowConfig: () => loadProject(args.yamlPath).workflow,
    runSession: startSession,
    updateItem: (itemId, fields) => updateProjectItem(args.yamlPath, itemId, fields),
    broadcast: (ev) => {
      const frame = `event: workflow\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const client of sseClients) client.write(frame);
    },
    graphify,
  });

  // Watch the yaml's directory (watching the file directly breaks on
  // editors/agents that replace the file) and notify viewers, debounced.
  let debounce = null;
  const reloadDebounced = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of sseClients) client.write('event: reload\ndata: {}\n\n');
    }, 200);
  };
  // Wireframe edits should live-reload too; design/ may not exist yet, so
  // retry attaching whenever the project dir changes.
  let designWatcher = null;
  const watchDesign = () => {
    if (designWatcher) return;
    try {
      designWatcher = fs.watch(path.join(projectDir, 'design'), { recursive: true }, reloadDebounced);
    } catch { /* not created yet */ }
  };
  try {
    fs.watch(projectDir, (event, filename) => {
      watchDesign();
      if (filename && filename !== path.basename(args.yamlPath)) return;
      reloadDebounced();
    });
    watchDesign();
  } catch (e) {
    console.error(`Warning: file watching unavailable (${e.message}); live reload disabled`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/project') {
      const proj = loadProject(args.yamlPath);
      const wf = loadWireframes(projectDir, proj.items);
      const wfState = workflow.getState();
      const items = proj.items.map((i) => (i && i.id ? { ...i, plan: planInfo(projectDir, wfState, i) } : i));
      return sendJson(res, 200, { ...proj, items, errors: [...proj.errors, ...wf.errors], flows: wf.flows });
    }

    if (url.pathname === '/api/priority') {
      return sendJson(res, 200, computePriority(loadProject(args.yamlPath).items));
    }

    if (url.pathname === '/api/graphify/status') {
      return sendJson(res, 200, graphify.status(projectDir));
    }

    if (url.pathname === '/api/graphify/graph.html') {
      return fs.readFile(graphify.paths(projectDir).html, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'No graph generated yet' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    }

    if (url.pathname === '/api/graphify/regenerate' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      if (!graphify.available) return sendJson(res, 503, { error: 'graphify is not installed' });
      return sendJson(res, 200, graphify.ensureGraphFresh(projectDir, { force: true }));
    }

    if (url.pathname === '/api/workflow' && req.method === 'GET') {
      return sendJson(res, 200, { state: workflow.getState(), transcript: workflow.getTranscript(), steps: STEPS });
    }

    if (url.pathname === '/api/workflow/start' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      return readBody(req).then((body) => {
        let itemId = null, step;
        try { ({ itemId, step } = JSON.parse(body)); } catch { /* handled below */ }
        if (!itemId) return sendJson(res, 400, { error: 'itemId required' });
        const r = workflow.start(itemId, step || 'brainstorm');
        return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r.state);
      }).catch(() => sendJson(res, 400, { error: 'Invalid request body' }));
    }

    if (url.pathname === '/api/workflow/plan-project' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      const r = workflow.planProject();
      return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r.state);
    }

    if (url.pathname === '/api/workflow/analyze-project' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      const r = workflow.analyzeProject();
      return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r.state);
    }

    if (url.pathname === '/api/workflow/continue' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      const r = workflow.advance();
      return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r.state);
    }

    if (url.pathname === '/api/workflow/stop' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      return workflow.stop()
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 409, { error: 'No running workflow session' });
    }

    if (url.pathname === '/api/workflow/input' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      return readBody(req).then((body) => {
        let text = null;
        try { text = JSON.parse(body).text; } catch { /* handled below */ }
        if (!text || !String(text).trim()) return sendJson(res, 400, { error: 'text required' });
        return workflow.input(String(text))
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 409, { error: 'No running workflow session' });
      }).catch(() => sendJson(res, 400, { error: 'Invalid request body' }));
    }

    if (url.pathname === '/api/items' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      return readBody(req).then((body) => {
        let fields = null;
        try { fields = JSON.parse(body); } catch { /* handled below */ }
        if (!fields || typeof fields !== 'object') return sendJson(res, 400, { error: 'Invalid request body' });
        const r = addProjectItem(args.yamlPath, fields);
        return r.error ? sendJson(res, 400, { error: r.error }) : sendJson(res, 200, r);
      }).catch(() => sendJson(res, 400, { error: 'Invalid request body' }));
    }

    if (url.pathname === '/api/spec') {
      const rel = url.searchParams.get('path') || '';
      const resolved = path.resolve(projectDir, rel);
      if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
        return sendJson(res, 403, { error: 'Spec path escapes the project directory' });
      }
      return fs.readFile(resolved, 'utf8', (err, data) => {
        if (err) return sendJson(res, 404, { error: `Spec not found: ${rel}` });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('event: hello\ndata: {}\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // Wireframe HTML, served same-origin so the viewer can render it in an
    // iframe and measure anchor elements inside it.
    if (url.pathname.startsWith('/design/wireframes/')) {
      const resolved = path.resolve(projectDir, '.' + path.posix.normalize(url.pathname));
      if (!resolved.startsWith(projectDir + path.sep)) {
        return sendJson(res, 403, { error: 'Wireframe path escapes the project directory' });
      }
      return fs.readFile(resolved, (err, data) => {
        if (err) return sendJson(res, 404, { error: `Wireframe not found: ${url.pathname}` });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    }

    // Static files from web/dist, with SPA fallback to index.html.
    let filePath = path.resolve(distDir, '.' + path.posix.normalize(url.pathname));
    if (!filePath.startsWith(distDir)) filePath = path.join(distDir, 'index.html');
    fs.stat(filePath, (err, stat) => {
      if (err || stat.isDirectory()) filePath = path.join(distDir, 'index.html');
      fs.readFile(filePath, (err2, data) => {
        if (err2) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('Viewer not built yet — run: npm run build');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
  });

  server.listen(args.port, '127.0.0.1', () => {
    const addr = `http://localhost:${args.port}`;
    console.log(`diagram-copilot serving ${args.yamlPath}`);
    console.log(`  ${addr}`);
    if (args.open) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open';
      execFile(opener, [addr], () => {}); // best-effort; fine if headless
    }
  });
}

if (require.main === module) main();
module.exports = { loadProject, computePriority, updateProjectItem, addProjectItem, parseWireframeFlows, loadWireframes, planInfo };
