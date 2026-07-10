import { useEffect, useState } from 'react';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatSystemMessage,
} from '@astryxdesign/core/Chat';
import { Markdown } from '@astryxdesign/core/Markdown';

export const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
};

// Shared live workflow state: initial fetch + SSE merge. Both the Workflow and
// Planning tabs render the same single server-side workflow.
export function useWorkflowFeed() {
  const [wf, setWf] = useState(null); // { state, transcript }

  useEffect(() => {
    let stale = false;
    fetch('/api/workflow')
      .then((r) => r.json())
      .then((d) => {
        if (stale) return;
        setWf((cur) => cur
          ? { state: cur.state ?? d.state, transcript: mergeTranscript(d.transcript, cur.transcript) }
          : d);
      })
      .catch(() => { if (!stale) setWf({ state: null, transcript: [] }); });
    const es = new EventSource('/api/events');
    es.addEventListener('workflow', (e) => {
      const ev = JSON.parse(e.data);
      setWf((cur) => {
        const base = cur || { state: null, transcript: [] };
        if (ev.kind === 'workflow') {
          const isNewRun = ev.state.stepStatus === 'running' && base.state?.startedAt !== ev.state.startedAt;
          return { state: ev.state, transcript: isNewRun ? [] : base.transcript };
        }
        return { ...base, transcript: mergeTranscript(base.transcript, [ev]) };
      });
    });
    return () => { stale = true; es.close(); };
  }, []);

  return wf;
}

export function TranscriptEvent({ ev }) {
  if (ev.kind === 'assistant-text') {
    return (
      <ChatMessage sender="assistant">
        <ChatMessageBubble variant="ghost">
          <Markdown density="compact" headingLevelStart={3}>{ev.text}</Markdown>
        </ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (ev.kind === 'user-text') {
    return (
      <ChatMessage sender="user">
        <ChatMessageBubble>{ev.text}</ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (ev.kind === 'tool-use') {
    return <ChatSystemMessage>{ev.name}{ev.summary ? ` · ${ev.summary}` : ''}</ChatSystemMessage>;
  }
  if (ev.kind === 'step-start') {
    return <ChatSystemMessage variant="divider">{STEP_INFO[ev.step]?.label || ev.step}</ChatSystemMessage>;
  }
  if (ev.kind === 'session-start') {
    return <ChatSystemMessage>session started ({ev.model})</ChatSystemMessage>;
  }
  return null;
}
