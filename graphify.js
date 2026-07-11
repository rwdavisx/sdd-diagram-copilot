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

  return {
    ensureInstalled,
    get available() { return available; },
    get installHint() { return installHint; },
  };
}

module.exports = { createGraphify, OUT_DIR };
