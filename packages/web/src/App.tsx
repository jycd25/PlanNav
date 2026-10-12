import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Settings } from '@ds/core';
import * as api from './api.js';
import { addDays, fmtRangeLabel, isoDate, startOfDay, startOfWeek, isSameDay } from './time.js';
import { CalendarView } from './calendar/CalendarView.js';
import { ChatPanel } from './chat/ChatPanel.js';
import { TasksPanel } from './panels/TasksPanel.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { BaselineView } from './baseline/BaselineView.js';
import { describeApply, syncDraft, type Draft } from './baseline/map.js';

type View = 'day' | 'week' | 'baseline';
type Panel = 'tasks' | 'settings' | null;

const readView = (): View => { try { return (localStorage.getItem('ds.view') as View) || 'week'; } catch { return 'week'; } };

export function App() {
  const [view, setView] = useState<View>(readView);
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [now, setNow] = useState<Date>(() => new Date());
  const [state, setState] = useState<api.State | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<api.BaselineResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ slots: [], dirty: false, baseVersion: 0 });

  const weekStartsOn = state?.settings.weekStartsOn ?? 0;
  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    const s = startOfWeek(anchor, weekStartsOn);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [view, anchor, weekStartsOn]);

  const refresh = useCallback(async () => {
    try {
      const from = days[0];
      const to = addDays(days[days.length - 1], 1);
      const [s, b] = await Promise.all([api.getState(from, to), api.getBaseline()]);
      setState(s);
      setBaseline(b);
      // A clean baseline draft follows each newly saved version; a dirty one is kept (the Baseline tab says a newer one exists).
      setDraft((d) => syncDraft(d, b.baseline));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { try { localStorage.setItem('ds.view', view); } catch { /* ignore */ } }, [view]);
  // Unsaved baseline edits survive tab switches (the draft lives here); closing or reloading the page asks first.
  useEffect(() => {
    if (!draft.dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft.dirty]);

  const step = (n: number) => setAnchor((a) => addDays(a, view === 'day' ? n : 7 * n));
  // What the chat's starter bubbles need: whether this week has the baseline laid out, today's blocks, the task names.
  const chatContext = useMemo(() => {
    if (!state) return null;
    const ws = startOfWeek(now, weekStartsOn); const we = addDays(ws, 7);
    const inWeek = (b: { start: string }) => { const t = new Date(b.start); return t >= ws && t < we; };
    const weekApplied = state.blocks.some((b) => inWeek(b) && (b.source === 'baseline' || b.source === 'adjusted'));
    const todayBlocks = state.blocks.filter((b) => isSameDay(new Date(b.start), now)).map((b) => ({ taskName: b.taskName, start: b.start, end: b.end, status: b.status }));
    return { weekApplied, todayBlocks, tasks: state.tasks.filter((t) => !t.archived).sort((a, b) => a.priority - b.priority).map((t) => t.name), now };
  }, [state, now, weekStartsOn]);
  const settings: Settings | undefined = state?.settings;
  // The Week view offers to copy the baseline onto a week that has none of its blocks yet.
  const canApply = view === 'week' && !!baseline?.baseline && !!state && !state.blocks.some((b) => b.source === 'baseline' || b.source === 'adjusted');
  const applyHere = async () => {
    try {
      const r = await api.applyBaseline(isoDate(days[0]));
      setNotice(`Applied the baseline: ${describeApply(r, new Map((state?.tasks ?? []).map((t) => [t.id, t.name])))}`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="app layout-beside">
      <header className="toolbar">
        <div className="toolbar-left">
          <span className="brand">RerouteDay</span>
          {view === 'baseline' ? <h1 className="range">Baseline week</h1> : (<>
            <button className="btn" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
            <div className="nav">
              <button className="btn icon" aria-label="Previous" onClick={() => step(-1)}>‹</button>
              <button className="btn icon" aria-label="Next" onClick={() => step(1)}>›</button>
            </div>
            <h1 className="range">{fmtRangeLabel(days)}</h1>
            {canApply && <button className="btn" onClick={() => void applyHere()}>Apply baseline schedule</button>}
          </>)}
        </div>
        <div className="toolbar-right">
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={view === 'day'} className={view === 'day' ? 'on' : ''} onClick={() => setView('day')}>Day</button>
            <button role="tab" aria-selected={view === 'week'} className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}>Week</button>
            <button role="tab" aria-selected={view === 'baseline'} className={view === 'baseline' ? 'on' : ''} onClick={() => setView('baseline')}>Baseline{draft.dirty ? ' •' : ''}</button>
          </div>
          <button className="btn" onClick={() => setPanel('tasks')}>Tasks</button>
          <button className="btn" onClick={() => setPanel('settings')}>Settings</button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner info"><span>{notice}</span><button className="btn" onClick={() => setNotice(null)}>Dismiss</button></div>}

      <main className="workspace">
        <section className="calendar-pane">
          {state && settings && view === 'baseline' ? (
            <BaselineView saved={baseline} draft={draft} setDraft={setDraft} tasks={state.tasks} settings={settings} now={now} onChanged={refresh} />
          ) : state && settings ? (
            <CalendarView days={days} now={now} blocks={state.blocks} commitments={state.commitments} recurring={state.recurring} tasks={state.tasks} settings={settings} onChanged={refresh} />
          ) : (
            <div className="empty">Loading…</div>
          )}
        </section>
        <aside className="chat-pane">
          <ChatPanel onChanged={refresh} setup={state?.setup ?? null} context={chatContext} />
        </aside>
      </main>

      {panel === 'tasks' && state && <TasksPanel tasks={state.tasks} baseline={baseline?.baseline ?? null} onClose={() => setPanel(null)} onChanged={refresh} />}
      {panel === 'settings' && <SettingsPanel onClose={() => setPanel(null)} onChanged={refresh} />}
    </div>
  );
}
