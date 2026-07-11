// graphify.js — Graphify codebase-knowledge-graph integration: auto-install,
// background refresh, session prompt pointer, per-session MCP config, status.
// An enhancer, never a gate: every function degrades to a no-op / empty value
// when the CLI or graph is unavailable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const OUT_DIR = 'graphify-out';

function createGraphify({
  log = console.error,
  execFileFn = execFile,
  execFileSyncFn = execFileSync,
  spawnFn = spawn,
} = {}) {
  let available = false;
  let hasUv = false;
  let installHint = null;

  // Resolves true iff the command ran and exited 0. ENOENT -> false.
  const run = (cmd, args) => new Promise((resolve) => {
    execFileFn(cmd, args, { windowsHide: true }, (err) => resolve(!err));
  });

  // Check `graphify` on PATH; missing -> uv tool install, then pipx. On any
  // success, fire a background upgrade so the tool stays current. Failure is
  // logged once with a hint surfaced via installHint (shown by /api/graphify/status).
  async function ensureInstalled() {
    hasUv = await run('uv', ['--version']);
    if (await run('graphify', ['--version'])) available = true;
    else if (hasUv && await run('uv', ['tool', 'install', 'graphifyy'])) available = true;
    else if (await run('pipx', ['install', 'graphifyy'])) available = true;
    if (!available) {
      installHint = 'Graphify could not be installed (no uv or pipx found, or install failed). Install uv or pipx, then run: uv tool install graphifyy';
      log(installHint);
      return false;
    }
    // Fire-and-forget upgrade, once per server start; a failed upgrade is fine.
    run(hasUv ? 'uv' : 'pipx', hasUv ? ['tool', 'upgrade', 'graphifyy'] : ['upgrade', 'graphifyy']);
    return true;
  }

  const regenerating = new Set(); // projectDirs with a `graphify .` in flight

  function paths(projectDir) {
    const dir = path.join(projectDir, OUT_DIR);
    return {
      dir,
      html: path.join(dir, 'graph.html'),
      json: path.join(dir, 'graph.json'),
      report: path.join(dir, 'GRAPH_REPORT.md'),
      marker: path.join(dir, 'marker.json'),
    };
  }

  // Repo identity at a moment in time: HEAD + a hash of the dirty state.
  // null (not a git repo / git missing) means "can't tell" -> always regen.
  function stamp(projectDir) {
    try {
      const head = execFileSyncFn('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();
      const dirty = execFileSyncFn('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
      return `${head}:${crypto.createHash('sha1').update(dirty).digest('hex')}`;
    } catch { return null; }
  }

  function readMarker(projectDir) {
    try { return JSON.parse(fs.readFileSync(paths(projectDir).marker, 'utf8')); } catch { return null; }
  }

  // The graph outputs are build artifacts of the *target* project — keep them
  // out of its git history (same pattern as initProject's .superpowers/ entry).
  function ensureGitignored(projectDir) {
    const giPath = path.join(projectDir, '.gitignore');
    const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    if (!gi.split('\n').some((l) => l.trim() === `${OUT_DIR}/`)) {
      fs.writeFileSync(giPath, `${gi.replace(/\n?$/, '\n')}${OUT_DIR}/\n`);
    }
  }

  function regenerate(projectDir, stampAtSpawn) {
    if (regenerating.has(projectDir)) return;
    regenerating.add(projectDir);
    ensureGitignored(projectDir);
    let child;
    try {
      child = spawnFn('graphify', ['.'], { cwd: projectDir, stdio: 'ignore', windowsHide: true });
    } catch { regenerating.delete(projectDir); return; }
    child.on('error', () => regenerating.delete(projectDir));
    child.on('exit', (code) => {
      regenerating.delete(projectDir);
      if (code === 0) {
        // Marker records what the repo looked like when regen *started* —
        // edits made during a long regen correctly read as stale next check.
        fs.mkdirSync(paths(projectDir).dir, { recursive: true });
        fs.writeFileSync(paths(projectDir).marker,
          JSON.stringify({ stamp: stampAtSpawn, generatedAt: new Date().toISOString() }));
      }
    });
  }

  // Non-blocking freshness guarantee: compare marker vs current stamp; kick a
  // background regen when stale/missing and return immediately. The first
  // session after big changes sees a slightly-old graph; it converges.
  function ensureGraphFresh(projectDir, { force = false } = {}) {
    const hasGraph = fs.existsSync(paths(projectDir).html);
    if (!available) return { state: hasGraph ? 'fresh' : 'missing' }; // best we can offer
    const now = stamp(projectDir);
    const marker = readMarker(projectDir);
    if (!force && hasGraph && marker && now && marker.stamp === now) return { state: 'fresh' };
    regenerate(projectDir, now);
    return { state: hasGraph ? 'stale-regenerating' : 'missing' };
  }

  function status(projectDir) {
    if (!available) return { state: 'unavailable', generatedAt: null, hint: installHint };
    const marker = readMarker(projectDir);
    const generatedAt = marker ? marker.generatedAt : null;
    if (!fs.existsSync(paths(projectDir).html)) return { state: 'missing', generatedAt };
    const now = stamp(projectDir);
    const fresh = marker && now && marker.stamp === now && !regenerating.has(projectDir);
    return { state: fresh ? 'fresh' : 'stale-regenerating', generatedAt };
  }

  return {
    ensureInstalled,
    paths,
    ensureGraphFresh,
    status,
    get available() { return available; },
    get installHint() { return installHint; },
  };
}

module.exports = { createGraphify, OUT_DIR };
