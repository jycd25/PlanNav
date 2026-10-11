import { useState } from 'react';
import type { Baseline, Task } from '@ds/core';
import * as api from '../api.js';
import { fmtMinutes } from '../time.js';
import { taskSlotSummary } from '../baseline/map.js';

interface Form { id?: string; name: string; priority: number; color?: string }
const empty: Form = { name: '', priority: 1 };

/** What the baseline week gives a task: its time a week, its slots, the usual sitting and part of day. Not edited here. */
function fromBaseline(baseline: Baseline | null, taskId: string): string {
  const s = taskSlotSummary(baseline?.slots ?? [], taskId);
  if (s.slots === 0) return 'Not in your baseline yet: draw its slots on the Baseline tab';
  const part = s.partOfDay === 'varies' ? 'at varying times' : `${s.partOfDay}s`;
  return `From your baseline: ${fmtMinutes(s.weeklyMinutes)} a week in ${s.slots} slot${s.slots === 1 ? '' : 's'} · ${fmtMinutes(s.sessionMinutes)} sittings · ${part}`;
}

/**
 * Tasks: name, colour and priority. Budget, sitting length and part of the day come from the baseline week (shown
 * read-only); the stored budget fields are sent back unchanged because the task tool still requires them.
 */
export function TasksPanel({ tasks, baseline, onClose, onChanged }: { tasks: Task[]; baseline: Baseline | null; onClose: () => void; onChanged: () => Promise<void> | void }) {
  const [form, setForm] = useState<Form>(empty);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      const existing = form.id ? tasks.find((t) => t.id === form.id) : undefined;
      await api.upsertTask({
        ...(form.id ? { id: form.id } : {}), name: form.name, priority: form.priority, ...(form.color ? { color: form.color } : {}),
        budget_minutes: existing?.budgetMinutes || 60, budget_period: existing?.budgetPeriod ?? 'week',
      });
      setForm(empty);
      setError(null);
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const edit = (t: Task) => setForm({ id: t.id, name: t.name, priority: t.priority, color: t.color });
  const archive = async (t: Task) => {
    try { await api.archiveTask(t.id); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (<>
    <div className="scrim" onClick={onClose} />
    <div className="sheet" role="dialog" aria-label="Tasks">
      <div className="sheet-head"><span>Tasks</span><button className="btn" onClick={onClose}>Close</button></div>
      <div className="sheet-body">
        <div>
          {tasks.length === 0 && <div className="hint">No tasks yet. Add one below, import a past week as your baseline, or ask the assistant.</div>}
          {tasks.map((t) => (
            <div key={t.id} className="task-row">
              <span className="swatch" style={{ background: t.color }} />
              <span className="name">{t.name}</span>
              <span className="meta">P{t.priority} · {fromBaseline(baseline, t.id)}</span>
              <button className="btn" onClick={() => edit(t)}>Edit</button>
              <button className="btn danger" onClick={() => archive(t)}>Archive</button>
            </div>
          ))}
        </div>
        <h3>{form.id ? 'Edit task' : 'New task'}</h3>
        <div className="field"><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Deep work" /></div>
        <div className="grid2">
          <div className="field"><label>Priority (1 = highest)</label><input type="number" min={1} max={99} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></div>
          <div className="field"><label>Colour</label><input type="color" value={form.color ?? '#4f8cff'} onChange={(e) => setForm({ ...form, color: e.target.value })} /></div>
        </div>
        {form.id && <div className="hint">{fromBaseline(baseline, form.id)}.</div>}
        {!form.id && <div className="hint">Its time comes from the baseline week: after adding it, draw its slots on the Baseline tab.</div>}
        {error && <div className="banner error">{error}</div>}
        <div className="row">
          <button className="btn primary" onClick={save} disabled={!form.name.trim()}>{form.id ? 'Save' : 'Add task'}</button>
          {form.id && <button className="btn" onClick={() => setForm(empty)}>Cancel</button>}
        </div>
      </div>
    </div>
  </>);
}
