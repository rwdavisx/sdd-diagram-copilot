// sessions.js — headless Claude Code session plumbing for workflow steps.
// CommonJS; the ESM-only Agent SDK is loaded via dynamic import() in Task 2.

// Async-iterable queue: HTTP handlers push user messages in while the SDK
// reads them out. Closing ends the iteration (and thus the session).
function createInputQueue() {
  const pending = [];
  let notify = null;
  let closed = false;
  return {
    push(msg) {
      if (closed) return false;
      pending.push(msg);
      if (notify) { const n = notify; notify = null; n(); }
      return true;
    },
    close() {
      closed = true;
      if (notify) { const n = notify; notify = null; n(); }
    },
    get closed() { return closed; },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (pending.length) yield pending.shift();
        if (closed) return;
        await new Promise((resolve) => { notify = resolve; });
      }
    },
  };
}

function userMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// Short human label for a tool call, e.g. "Bash: npm test" -> shown as a chip.
function summarizeToolInput(name, input = {}) {
  for (const key of ['command', 'file_path', 'skill', 'description', 'pattern']) {
    if (input[key]) return String(input[key]);
  }
  return '';
}

// Flatten one SDK message into zero or more small UI events (see plan table).
function toUiEvents(msg) {
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    return [{ kind: 'session-start', sessionId: msg.session_id, model: msg.model }];
  }
  if (msg.type === 'stream_event') {
    // Live text deltas; the full assistant message still follows and is the
    // durable record. Subagent streams are skipped — parallel subagents would
    // interleave scrambled text into the one live bubble.
    if (msg.parent_tool_use_id) return [];
    const ev = msg.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      return [{ kind: 'assistant-delta', text: ev.delta.text }];
    }
    return [];
  }
  if (msg.type === 'assistant') {
    const events = [];
    for (const block of (msg.message && msg.message.content) || []) {
      if (block.type === 'text' && block.text.trim()) {
        events.push({ kind: 'assistant-text', text: block.text });
      } else if (block.type === 'tool_use') {
        events.push({ kind: 'tool-use', name: block.name, summary: summarizeToolInput(block.name, block.input) });
      }
    }
    return events;
  }
  if (msg.type === 'result') {
    return [{ kind: 'turn-end', ok: msg.subtype === 'success' && !msg.is_error, costUsd: msg.total_cost_usd ?? null }];
  }
  return [];
}

async function defaultQueryFn(args) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query(args);
}

// Start a headless Claude Code session with streaming input. The session
// stays alive across turns until close() (or an SDK error) ends it.
function startSession({ initialPrompt, cwd, resume, model, effort, onEvent, queryFn = defaultQueryFn }) {
  const input = createInputQueue();
  input.push(userMessage(initialPrompt));
  let q = null;
  let sessionId = resume || null;

  const done = (async () => {
    try {
      q = await queryFn({
        prompt: input,
        options: {
          cwd,
          resume,
          // Per-step model/effort from project.yaml `workflow:`; unset fields
          // fall back to the CLI's default model and effort.
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          includePartialMessages: true,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
        },
      });
      for await (const msg of q) {
        if (msg.session_id) sessionId = msg.session_id;
        for (const ev of toUiEvents(msg)) onEvent(ev);
      }
      return { ok: true, sessionId };
    } catch (e) {
      return { ok: false, sessionId, error: e.message };
    } finally {
      input.close();
    }
  })();

  return {
    send: (text) => input.push(userMessage(text)),
    close: () => input.close(),
    interrupt: async () => { if (q && q.interrupt) await q.interrupt().catch(() => {}); },
    done,
  };
}

module.exports = { createInputQueue, userMessage, summarizeToolInput, toUiEvents, startSession };
