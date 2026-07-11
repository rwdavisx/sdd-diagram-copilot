import { useEffect, useState } from 'react';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
} from '@astryxdesign/core/Chat';
import { Avatar } from '@astryxdesign/core/Avatar';
import { HStack } from '@astryxdesign/core/HStack';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';

export const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// One EventSource for the whole page. Browsers cap HTTP/1.1 at ~6 connections
// per host; an EventSource per component (times several open tabs) exhausts
// the pool and silently starves every later fetch. Lives for the page's
// lifetime; subscribers just detach their listener.
let es = null;
export function onServerEvent(event, handler) {
  if (!es) es = new EventSource('/api/events');
  es.addEventListener(event, handler);
  return () => es.removeEventListener(event, handler);
}

export const mergeTranscript = (a, b) => {
  const bySeq = new Map([...a, ...b].map((ev) => [ev.seq, ev]));
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
};

export const STEP_INFO = {
  brainstorm: { label: 'Brainstorm', desc: 'Chat to refine the idea into an approved spec (specs/<id>.md)' },
  worktree: { label: 'Worktree', desc: 'Create an isolated branch + worktree' },
  plan: { label: 'Plan', desc: 'Write the step-by-step implementation plan' },
  execute: { label: 'Execute', desc: 'Subagents implement each task with TDD' },
  review: { label: 'Review', desc: 'Code review of the finished branch' },
  finish: { label: 'Finish', desc: 'Merge / PR / keep / discard — you choose in chat' },
  'plan-project': { label: 'Plan project', desc: 'Chat to plan the whole app; items land in project.yaml live' },
  'analyze-project': { label: 'Analyze codebase', desc: 'Agents reverse-engineer the existing code; items land in project.yaml live' },
};

// Shared live workflow state: initial fetch + SSE merge. Both the Workflow and
// Planning tabs render the same single server-side workflow.
export function useWorkflowFeed() {
  const [wf, setWf] = useState(null); // { state, transcript, pending }

  useEffect(() => {
    let stale = false;
    fetch('/api/workflow')
      .then((r) => r.json())
      .then((d) => {
        if (stale) return;
        setWf((cur) => cur
          ? { ...cur, state: cur.state ?? d.state, transcript: mergeTranscript(d.transcript, cur.transcript) }
          : { ...d, pending: '' });
      })
      .catch(() => { if (!stale) setWf({ state: null, transcript: [], pending: '' }); });
    const off = onServerEvent('workflow', (e) => {
      const ev = JSON.parse(e.data);
      setWf((cur) => {
        const base = cur || { state: null, transcript: [], pending: '' };
        if (ev.kind === 'workflow') {
          const isNewRun = ev.state.stepStatus === 'running' && base.state?.startedAt !== ev.state.startedAt;
          return { state: ev.state, transcript: isNewRun ? [] : base.transcript, pending: isNewRun ? '' : base.pending };
        }
        // Live text deltas accumulate into the streaming bubble; any durable
        // transcript event supersedes whatever was streaming.
        if (ev.kind === 'assistant-delta') {
          return { ...base, pending: (base.pending || '') + ev.text };
        }
        return { ...base, pending: '', transcript: mergeTranscript(base.transcript, [ev]) };
      });
    });
    return () => { stale = true; off(); };
  }, []);

  return wf;
}

// Collapse consecutive tool-use events into one group so they render as a
// single ChatToolCalls block instead of a run of system-message lines.
export const groupTranscript = (transcript) => {
  const out = [];
  for (const ev of transcript) {
    const last = out[out.length - 1];
    if (ev.kind === 'tool-use') {
      if (last?.kind === 'tool-group') last.calls.push(ev);
      else out.push({ kind: 'tool-group', seq: ev.seq, calls: [ev] });
    } else {
      out.push(ev);
    }
  }
  return out;
};

const assistantAvatar = <Avatar name="Claude" size="small" />;

export function TranscriptEvent({ ev, isActive = false }) {
  const meta = ev.at && (
    <ChatMessageMetadata timestamp={<Timestamp value={ev.at} format="time" />} />
  );
  if (ev.kind === 'assistant-text') {
    return (
      <ChatMessage sender="assistant" avatar={assistantAvatar}>
        <ChatMessageBubble variant="ghost" metadata={meta}>
          <Markdown density="compact" headingLevelStart={3}>{ev.text}</Markdown>
        </ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (ev.kind === 'user-text') {
    return (
      <ChatMessage sender="user">
        <ChatMessageBubble metadata={meta}>{ev.text}</ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (ev.kind === 'tool-group') {
    return (
      <ChatToolCalls
        calls={ev.calls.map((c, i) => ({
          key: String(c.seq),
          name: c.name,
          target: c.summary || undefined,
          status: isActive && i === ev.calls.length - 1 ? 'running' : 'complete',
        }))}
      />
    );
  }
  if (ev.kind === 'step-start') {
    return <ChatSystemMessage variant="divider">{STEP_INFO[ev.step]?.label || ev.step}</ChatSystemMessage>;
  }
  if (ev.kind === 'session-start') {
    return <ChatSystemMessage>session started ({ev.model})</ChatSystemMessage>;
  }
  return null;
}

// Whether Claude owes us a response: scan back for the last turn boundary.
// A turn starts at step-start (the initial prompt) or user-text (a reply)
// and ends at turn-end — after that the session is waiting on the human,
// so no busy indicator belongs on screen.
export const turnBusy = (transcript) => {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const k = transcript[i].kind;
    if (k === 'turn-end') return false;
    if (k === 'user-text' || k === 'step-start') return true;
  }
  return true; // nothing recorded yet — the initial prompt is being processed
};

// The transcript plus the live tail: a streaming bubble while text is arriving,
// or a "working" indicator while Claude is busy between messages.
export function Transcript({ transcript, pending, running, children }) {
  const groups = groupTranscript(transcript);
  const busy = running && turnBusy(transcript);
  return (
    <>
      {groups.map((ev, i) => (
        <TranscriptEvent key={ev.seq} ev={ev} isActive={busy && i === groups.length - 1} />
      ))}
      {running && pending && (
        <ChatMessage sender="assistant" avatar={assistantAvatar}>
          <ChatMessageBubble variant="ghost">
            <Markdown density="compact" headingLevelStart={3}>{pending}</Markdown>
          </ChatMessageBubble>
        </ChatMessage>
      )}
      {busy && !pending && (
        <ChatMessage sender="assistant" avatar={assistantAvatar}>
          <ChatMessageBubble variant="ghost">
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" />
              <Text type="supporting" color="secondary">Working…</Text>
            </HStack>
          </ChatMessageBubble>
        </ChatMessage>
      )}
      {children}
    </>
  );
}
