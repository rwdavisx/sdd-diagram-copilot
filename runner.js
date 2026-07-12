// runner.js — service runner: spawns items' `run:` blocks as child processes
// of this server, tracks status, kills whole process trees on stop, and
// reports everything over the caller's broadcast. Children die with us —
// no detached processes, no PID files.
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const MAX_OUTPUT_LINES = 200;

function validateRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return 'run must be a mapping';
  if (!run.cmd || typeof run.cmd !== 'string') return 'run.cmd must be a non-empty string';
  if (run.port != null && !Number.isInteger(run.port)) return 'run.port must be an integer';
  if (run.env != null && (typeof run.env !== 'object' || Array.isArray(run.env))) return 'run.env must be a mapping';
  return null;
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

// npm/vite wrap the real server in child processes — killing just the shell
// pid leaks the tree, so always kill the whole tree.
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM'); // works because we spawn detached (own group)
    }
  } catch { /* already dead */ }
}

function createRunner({ projectDir, loadServices, broadcast = () => {}, readyDelayMs = 2000, pollMs = 250 }) {
  // id -> { child, pid, status, startedAt, config, output, stopRequested, timer }
  const procs = new Map();

  const alive = (p) => p && (p.status === 'starting' || p.status === 'running');

  function push(p, text) {
    for (const line of String(text).split(/\r?\n/)) if (line) p.output.push(line);
    if (p.output.length > MAX_OUTPUT_LINES) p.output.splice(0, p.output.length - MAX_OUTPUT_LINES);
  }

  function setStatus(p, id, status) {
    p.status = status;
    broadcast({ id, status });
  }

  function start(id) {
    const svc = loadServices().find((s) => s.id === id);
    if (!svc) return { error: `Unknown service "${id}"`, code: 404 };
    const bad = validateRun(svc.run);
    if (bad) return { error: bad, code: 400 };
    if (alive(procs.get(id))) return { error: `"${id}" is already ${procs.get(id).status}`, code: 409 };

    const run = svc.run;
    const child = spawn(run.cmd, {
      shell: true,
      cwd: path.resolve(projectDir, run.cwd || '.'),
      env: { ...process.env, ...(run.env || {}) },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const p = {
      child, pid: child.pid, status: 'starting', startedAt: new Date().toISOString(),
      config: JSON.stringify(run), output: [], stopRequested: false, timer: null,
    };
    procs.set(id, p);
    broadcast({ id, status: 'starting' });

    child.stdout.on('data', (d) => push(p, d));
    child.stderr.on('data', (d) => push(p, d));
    child.on('error', (e) => {
      clearTimeout(p.timer);
      push(p, `spawn error: ${e.message}`);
      if (alive(p)) setStatus(p, id, 'crashed');
    });
    child.on('exit', (code) => {
      clearTimeout(p.timer);
      if (!alive(p)) return;
      setStatus(p, id, p.stopRequested || code === 0 ? 'stopped' : 'crashed');
    });

    // Readiness: declared port answers -> running; no port -> assume running
    // after a grace delay (crash-on-boot flips it to crashed via 'exit').
    if (run.port) {
      p.timer = setInterval(async () => {
        if (p.status !== 'starting') return clearTimeout(p.timer);
        if (await portListening(run.port) && p.status === 'starting') {
          clearTimeout(p.timer);
          setStatus(p, id, 'running');
        }
      }, pollMs);
    } else {
      p.timer = setTimeout(() => { if (p.status === 'starting') setStatus(p, id, 'running'); }, readyDelayMs);
    }
    return { ok: true };
  }

  function stop(id) {
    const p = procs.get(id);
    if (!alive(p)) return { error: `"${id}" is not running`, code: 409 };
    p.stopRequested = true;
    killTree(p.pid);
    return { ok: true };
  }

  function waitWhile(id, pred, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const st = procs.get(id) && procs.get(id).status;
        if (!pred(st) || Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(st); }
      }, 50);
    });
  }

  async function restart(id) {
    if (alive(procs.get(id))) {
      const r = stop(id);
      if (r.error) return r;
      await waitWhile(id, (s) => s === 'starting' || s === 'running');
    }
    return start(id);
  }

  async function entry(svc) {
    const invalid = validateRun(svc.run);
    const p = procs.get(svc.id);
    const port = (svc.run && Number.isInteger(svc.run.port)) ? svc.run.port : null;
    if (alive(p)) {
      return {
        id: svc.id, name: svc.name, status: p.status, pid: p.pid, port,
        startedAt: p.startedAt, stale: p.config !== JSON.stringify(svc.run), invalid,
      };
    }
    // Not ours: a listener on the declared port is some external process.
    if (port && await portListening(port)) {
      return { id: svc.id, name: svc.name, status: 'external', pid: null, port, startedAt: null, stale: false, invalid };
    }
    return { id: svc.id, name: svc.name, status: p ? p.status : 'stopped', pid: null, port, startedAt: null, stale: false, invalid };
  }

  function list() {
    return Promise.all(loadServices().map(entry));
  }

  async function get(id) {
    const svc = loadServices().find((s) => s.id === id);
    if (!svc) return null;
    const p = procs.get(id);
    return { ...(await entry(svc)), output: p ? p.output : [] };
  }

  // Kahn-ish topological order over `depends`, restricted to services.
  // A cycle just appends the remainder — start order degrades, never blocks.
  function topoOrder(services) {
    const ids = new Set(services.map((s) => s.id));
    const order = [];
    const done = new Set();
    while (order.length < services.length) {
      const ready = services.filter((s) => !done.has(s.id) &&
        (Array.isArray(s.depends) ? s.depends : []).filter((d) => ids.has(d)).every((d) => done.has(d)));
      if (!ready.length) {
        for (const s of services) if (!done.has(s.id)) { order.push(s); done.add(s.id); }
        break;
      }
      for (const s of ready) { order.push(s); done.add(s.id); }
    }
    return order;
  }

  async function startAll() {
    for (const svc of topoOrder(loadServices())) {
      if (alive(procs.get(svc.id))) continue;
      if ((await entry(svc)).status === 'external') continue;
      if (start(svc.id).error) continue; // invalid config — skip, banner already reports it
      await waitWhile(svc.id, (s) => s === 'starting'); // dependents wait for running/crashed
    }
    return { ok: true };
  }

  async function stopAll() {
    for (const svc of topoOrder(loadServices()).reverse()) {
      if (!alive(procs.get(svc.id))) continue;
      stop(svc.id);
      await waitWhile(svc.id, (s) => s === 'starting' || s === 'running');
    }
    return { ok: true };
  }

  function shutdownSync() {
    for (const p of procs.values()) {
      if (alive(p)) { p.stopRequested = true; killTree(p.pid); }
    }
  }

  return { start, stop, restart, get, list, startAll, stopAll, shutdownSync };
}

module.exports = { createRunner, validateRun };
