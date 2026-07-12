// graphify.js — Graphify codebase-knowledge-graph integration: auto-install
// (bootstrapping uv itself when missing), background refresh, session prompt
// pointer, per-session MCP config, status. The CLI is a required dependency:
// server startup fails if ensureInstalled() cannot make it available. The
// graph itself stays async — functions degrade to empty values until it exists.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const OUT_DIR = 'graphify-out';

function createGraphify({
  log = console.error,
  execFileFn = execFile,
  execFileSyncFn = execFileSync,
  spawnFn = spawn,
  existsFn = fs.existsSync,
  env = process.env,
} = {}) {
  let available = false;
  let uvCmd = null; // resolved uv invocation (bare name or absolute path), null if absent
  let graphifyCmd = 'graphify';
  let installHint = null;

  // Resolves true iff the command ran and exited 0. ENOENT -> false.
  const run = (cmd, args) => new Promise((resolve) => {
    execFileFn(cmd, args, { windowsHide: true }, (err) => resolve(!err));
  });

  // uv's installer (and uv tool install / pipx) drop binaries in ~/.local/bin,
  // which is not on this process's PATH right after a fresh install — so
  // resolve via PATH first, then check there explicitly.
  const localBin = (name) => path.join(os.homedir(), '.local', 'bin',
    process.platform === 'win32' ? `${name}.exe` : name);
  const resolveCmd = async (name) => {
    if (await run(name, ['--version'])) return name;
    const p = localBin(name);
    return (existsFn(p) && await run(p, ['--version'])) ? p : null;
  };

  // Graphify is a required dependency: resolve or install the CLI,
  // bootstrapping uv itself via the official installer when missing. pipx
  // stays as a fallback. Only a full-chain failure (network, blocked
  // installer) returns false — the server treats that as fatal at startup.
  async function ensureInstalled() {
    uvCmd = await resolveCmd('uv');
    let g = await resolveCmd('graphify');
    if (!g) {
      if (!uvCmd) {
        if (process.platform === 'win32') {
          await run('powershell', ['-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex']);
        } else {
          await run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
        }
        uvCmd = await resolveCmd('uv');
      }
      if (uvCmd && await run(uvCmd, ['tool', 'install', 'graphifyy'])) g = (await resolveCmd('graphify')) || 'graphify';
      else if (await run('pipx', ['install', 'graphifyy'])) g = (await resolveCmd('graphify')) || 'graphify';
    }
    if (!g) {
      installHint = 'Graphify is required but could not be installed (uv bootstrap or `uv tool install graphifyy` failed). Install uv (https://astral.sh/uv), run `uv tool install graphifyy`, then relaunch.';
      log(installHint);
      return false;
    }
    graphifyCmd = g;
    available = true;
    // Fire-and-forget upgrade, once per server start; a failed upgrade is fine.
    run(uvCmd || 'pipx', uvCmd ? ['tool', 'upgrade', 'graphifyy'] : ['upgrade', 'graphifyy']);
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

  // Doc/image extraction and community naming need an LLM key; without one a
  // bare `graphify .` exits 1. Keyless fallback: `--code-only` (local AST)
  // followed by `cluster-only --no-label`, which produces graph.html and
  // GRAPH_REPORT.md without any LLM.
  const LLM_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];

  function regenerate(projectDir, stampAtSpawn) {
    if (regenerating.has(projectDir)) return;
    regenerating.add(projectDir);
    ensureGitignored(projectDir);
    const stages = LLM_KEYS.some((k) => env[k])
      ? [['.']]
      : [['.', '--code-only'], ['cluster-only', '.', '--no-label']];
    const runStage = (i) => {
      let child;
      try {
        child = spawnFn(graphifyCmd, stages[i], { cwd: projectDir, stdio: 'ignore', windowsHide: true });
      } catch { regenerating.delete(projectDir); return; }
      child.on('error', () => regenerating.delete(projectDir));
      child.on('exit', (code) => {
        if (code !== 0) { regenerating.delete(projectDir); return; }
        if (i + 1 < stages.length) return runStage(i + 1);
        regenerating.delete(projectDir);
        // Marker records what the repo looked like when regen *started* —
        // edits made during a long regen correctly read as stale next check.
        fs.mkdirSync(paths(projectDir).dir, { recursive: true });
        fs.writeFileSync(paths(projectDir).marker,
          JSON.stringify({ stamp: stampAtSpawn, generatedAt: new Date().toISOString() }));
      });
    };
    runStage(0);
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

  // One paragraph appended to each workflow session's initial prompt. Absolute
  // main-checkout paths so sessions running inside a worktree still find the
  // shared graph. Empty string when there is nothing to point at.
  function sessionContext(projectDir) {
    const p = paths(projectDir);
    if (!fs.existsSync(p.report) || !fs.existsSync(p.json)) return '';
    return `\n\nA Graphify knowledge graph of this codebase is available. For instant orientation read ${p.report} (key concepts, connections, suggested questions); the full graph is at ${p.json}. Consult the graph before exploratory grepping.`;
  }

  // Stdio MCP server config for the Agent SDK, giving sessions live graph
  // query tools (query_graph, get_node, get_neighbors, shortest_path, ...).
  // ponytail: upstream only documents `python -m graphify.serve`; with uv we
  // launch through `uv run --with graphifyy` so the module resolves in an
  // isolated env. Revisit if graphify ships a first-class serve entry point.
  function mcpServers(projectDir) {
    const p = paths(projectDir);
    if (!available || !fs.existsSync(p.json)) return null;
    const serve = ['-m', 'graphify.serve', p.json, '--transport', 'stdio'];
    return {
      graphify: uvCmd
        ? { type: 'stdio', command: uvCmd, args: ['run', '--with', 'graphifyy', 'python', ...serve] }
        : { type: 'stdio', command: 'python', args: serve },
    };
  }

  return {
    ensureInstalled,
    paths,
    ensureGraphFresh,
    sessionContext,
    mcpServers,
    status,
    get available() { return available; },
    get installHint() { return installHint; },
  };
}

module.exports = { createGraphify, OUT_DIR };
