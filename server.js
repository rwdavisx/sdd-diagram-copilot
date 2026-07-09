#!/usr/bin/env node
// diagram-copilot server: serves a project.yaml as JSON, spec markdown, and
// SSE reload events, plus the built viewer from web/dist.
// Usage: node server.js <path-to-project.yaml> [--port 4400]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');

const TYPES = ['frontend', 'backend', 'integration'];
const STATUSES = ['planned', 'in-progress', 'shipped'];

function parseArgs(argv) {
  const args = { port: 4400, yamlPath: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--no-open') args.open = false;
    else if (!args.yamlPath) args.yamlPath = a;
  }
  if (!args.yamlPath || !Number.isInteger(args.port)) {
    console.error('Usage: node server.js <path-to-project.yaml> [--port 4400] [--no-open]');
    process.exit(1);
  }
  args.yamlPath = path.resolve(args.yamlPath);
  return args;
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
  }
  for (const item of items) {
    if (!item || !Array.isArray(item.depends)) continue;
    for (const dep of item.depends) {
      if (!ids.has(dep)) errors.push(`Item "${item.id}" depends on unknown id "${dep}"`);
    }
  }
  return { project: doc.project || path.basename(path.dirname(yamlPath)), items, errors };
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2',
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = path.dirname(args.yamlPath);
  const distDir = path.join(__dirname, 'web', 'dist');
  const sseClients = new Set();

  // Watch the yaml's directory (watching the file directly breaks on
  // editors/agents that replace the file) and notify viewers, debounced.
  let debounce = null;
  try {
    fs.watch(projectDir, (event, filename) => {
      if (filename && filename !== path.basename(args.yamlPath)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        for (const client of sseClients) client.write('event: reload\ndata: {}\n\n');
      }, 200);
    });
  } catch (e) {
    console.error(`Warning: file watching unavailable (${e.message}); live reload disabled`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/project') {
      return sendJson(res, 200, loadProject(args.yamlPath));
    }

    if (url.pathname === '/api/priority') {
      return sendJson(res, 200, computePriority(loadProject(args.yamlPath).items));
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

  server.listen(args.port, () => {
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
module.exports = { loadProject, computePriority };
