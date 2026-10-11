import { useEffect, useRef, useState } from 'react';
import type { SetupStatus } from '@ds/core';
import * as api from '../api.js';
import { applyEvent, pendingHint, type Message } from './reducer.js';
import { toolLabel } from './toolLabel.js';
import { markdownToHtml } from './markdown.js';
import { suggestions, type SuggestionContext } from './suggestions.js';

const SETUP_PROMPT = "Let's set up my schedule.";

export function ChatPanel({ onChanged, setup, context }: { onChanged: () => Promise<void> | void; setup: SetupStatus | null; context: Omit<SuggestionContext, 'ready'> | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages]);
  // Start the assistant while the user reads and types, so the first reply does not wait for it to start.
  useEffect(() => { api.warmChat().catch(() => { /* the first message starts it instead */ }); }, []);

  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The orientation card's import makes the baseline week from the file's past events; the header's import adds busy time.
  const baselineRef = useRef<HTMLInputElement>(null);
  const importFile = async (file: File, asBaseline = false) => {
    try {
      const text = await file.text();
      if (asBaseline) setImportNote((await api.importAsBaseline({ ics: text })).summary);
      else {
        const r = await api.importIcs(text);
        setImportNote([r.summary, ...r.notes].join(' '));
      }
      await onChanged();
    } catch (e) { setImportNote(e instanceof Error ? e.message : String(e)); }
  };

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', parts: [{ type: 'text', text }] }, { role: 'assistant', parts: [] }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const e of api.chat(text, ac.signal)) {
        setMessages((m) => applyEvent(m, e));
        if (e.type === 'tool_result' || e.type === 'done') await onChanged();
      }
    } catch (err) {
      setMessages((m) => applyEvent(m, { type: 'error', message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      // Keep the keyboard in the box so the next message can be typed without clicking.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  // Starter bubbles follow the state: setup, apply the baseline, or today's day. A click prefills the box; Enter sends.
  const chips = setup && context ? suggestions({ ready: setup.ready, ...context }) : [];

  const reset = async () => {
    abortRef.current?.abort();
    try { await api.resetChat(); await api.warmChat(); } catch { /* ignore */ }
    setMessages([]);
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <span>Assistant</span>
        <div className="row">
          <button className="btn" onClick={() => fileRef.current?.click()} title="Import an .ics file exported from Apple Calendar or Google Calendar">Import .ics</button>
          <button className="btn" onClick={reset}>New chat</button>
        </div>
        <input ref={fileRef} type="file" accept=".ics,text/calendar" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        <input ref={baselineRef} type="file" accept=".ics,text/calendar" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f, true); e.target.value = ''; }} />
      </div>
      {importNote && <div className="hint" style={{ padding: '6px 12px' }}>{importNote}</div>}
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && setup && !setup.ready && (
          <div className="setup-card">
            <h4>Let’s set up your week</h4>
            <p>Import a past week as your baseline, or draw your typical week on the Baseline tab.</p>
            <div className="row">
              <button className="btn primary" onClick={() => baselineRef.current?.click()}>Import a past week (.ics)</button>
              <button className="btn" onClick={() => void send(SETUP_PROMPT)} disabled={busy}>Ask the assistant</button>
            </div>
            <p className="hint">Google Calendar: paste its “secret address in iCal format” into the chat and say “use it as my baseline”, or use Settings → Import with “Use as my baseline”. Apple Calendar: File → Export → Export…, then import the .ics with the button above.</p>
          </div>
        )}
        {messages.length === 0 && setup?.ready && (
          <div className="hint">Pick a starter below or type your own: the assistant changes the calendar only through its tools and says what it did.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.parts.map((p, j) => p.type === 'text'
              ? (m.role === 'assistant' ? <div key={j} className="md" dangerouslySetInnerHTML={{ __html: markdownToHtml(p.text) }} /> : <span key={j}>{p.text}</span>)
              : <div key={j} className={`tool${p.pending ? ' pending' : ''}${p.isError ? ' error' : ''}`} title={JSON.stringify(p.input)}><span className="dot" /><span className="label">{toolLabel(p)}</span></div>)}
            {i === messages.length - 1 && pendingHint(m, busy) && <span className="hint">{pendingHint(m, busy)}</span>}
          </div>
        ))}
      </div>
      {chips.length > 0 && !busy && (
        <div className="chips" aria-label="Suggested messages">
          {chips.map((c) => <button key={c} type="button" className="chip" onClick={() => { setInput(c); requestAnimationFrame(() => inputRef.current?.focus()); }}>{c}</button>)}
        </div>
      )}
      <div className="chat-input">
        <textarea ref={inputRef} value={input} placeholder={busy ? 'Replying… you can type the next message' : 'Message the scheduler…'} rows={1} autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) void send(); } }} />
        <button className="btn primary" onClick={() => void send()} disabled={busy || !input.trim()}>Send</button>
      </div>
      <div className="chat-hint">Enter to send, Shift+Enter for a new line.</div>
    </div>
  );
}
