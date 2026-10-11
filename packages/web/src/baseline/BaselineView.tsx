import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Baseline, BaselineSlot, Settings, Task } from '@ds/core';
import * as api from '../api.js';
import { addDays, isoDate } from '../time.js';
import { CalendarView, type TemplateEditor } from '../calendar/CalendarView.js';
import { calendarFromSlots, describeApply, moveSlot, newerSavedVersion, referenceWeek, slotFromRange, slotIndex, type Draft } from './map.js';

export interface BaselineViewProps {
  saved: api.BaselineResponse | null;
  /** The draft lives in App so switching to Day or Week and back keeps unsaved edits. */
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  tasks: Task[];
  settings: Settings;
  now: Date;
  /** After a save, revert or apply: refresh the app's state and the saved baseline. */
  onChanged: () => Promise<void> | void;
}

const MIDNIGHT_NOTE = 'A slot must end by midnight. Split it into two slots instead.';
const fmtSaved = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown time');
/** The template calendar edits only the draft; nothing on the server changes until Save. */
const noop = () => undefined;

/**
 * The baseline week: a template week drawn on the ordinary calendar (synthetic dates of a fixed reference week, see
 * map.ts). Edits change the draft; "Save baseline" stores the draft whole as a new version.
 */
export function BaselineView({ saved, draft, setDraft, tasks, settings, now, onChanged }: BaselineViewProps) {
  const savedBaseline = saved?.baseline ?? null;
  const savedVersion = savedBaseline?.version ?? 0;
  const [note, setNote] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => referenceWeek(settings.weekStartsOn), [settings.weekStartsOn]);
  const taskNames = useMemo(() => new Map(tasks.map((t) => [t.id, t.name])), [tasks]);
  const slots = draft.slots;
  const { blocks, commitments } = useMemo(() => calendarFromSlots(slots, days, taskNames), [slots, days, taskNames]);

  // Rebuilt only when the slots change, so the calendar's drag effect does not re-subscribe on every render.
  const editor = useMemo<TemplateEditor>(() => {
    const edit = (next: BaselineSlot[] | null) => {
      if (!next) { setNote(MIDNIGHT_NOTE); return; }
      setDraft((d) => ({ ...d, slots: next, dirty: true }));
      setNote(null);
    };
    const add = (slot: Omit<BaselineSlot, 'day' | 'start' | 'end'>, start: Date, end: Date) => {
      const range = slotFromRange(start, end);
      edit(range ? [...slots, { ...range, ...slot }] : null);
    };
    return {
      move: (id, start, end) => edit(moveSlot(slots, id, start, end)),
      addTask: (taskId, start, end) => add({ kind: 'task', taskId }, start, end),
      addBusy: (title, start, end) => add({ kind: 'busy', title }, start, end),
      remove: (id) => { const i = slotIndex(id); edit(slots.filter((_, j) => j !== i)); },
      setTask: (id, taskId) => { const i = slotIndex(id); edit(slots.map((s, j) => (j === i ? { ...s, taskId } : s))); },
    };
  }, [slots, setDraft]);

  const loadSaved = (b: Baseline | null) => setDraft({ slots: b?.slots ?? [], dirty: false, baseVersion: b?.version ?? 0 });
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    try { setNote(await action()); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const save = () => run(async () => {
    const r = await api.saveBaseline(slots);
    loadSaved(r.baseline);
    await onChanged();
    return `Saved as version ${r.baseline?.version}.`;
  });
  const discard = () => { loadSaved(savedBaseline); setNote(null); };
  const revert = (version: number) => run(async () => {
    const r = await api.revertBaseline(version);
    loadSaved(r.baseline);
    setShowVersions(false);
    await onChanged();
    return `Restored version ${version} as version ${r.baseline?.version}.`;
  });
  const apply = (weekOf: Date, label: string) => run(async () => {
    const r = await api.applyBaseline(isoDate(weekOf));
    await onChanged();
    return `Applied to ${label}: ${describeApply(r, taskNames)}`;
  });

  const versions = [...(saved?.versions ?? [])].sort((a, b) => b.version - a.version);
  const dirty = draft.dirty;
  const newer = newerSavedVersion(draft, savedBaseline);
  const applyTitle = dirty ? 'Save the baseline first: apply copies the saved version' : undefined;

  return (
    <div className="baseline-editor">
      <div className="baseline-bar">
        <span className="hint">
          {saved?.baseline ? `Version ${saved.baseline.version}, saved ${fmtSaved(saved.baseline.savedAt)}` : 'No baseline yet: drag on the week to draw one, or import a past week in Settings.'}
          {dirty && <strong> · Unsaved changes</strong>}
        </span>
        <div className="row">
          <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>Save baseline</button>
          {dirty && <button className="btn" disabled={busy} onClick={discard}>Discard</button>}
          <button className="btn" disabled={versions.length === 0} onClick={() => setShowVersions((v) => !v)} aria-expanded={showVersions}>Versions</button>
          <button className="btn" disabled={!saved?.baseline || dirty || busy} title={applyTitle} onClick={() => void apply(now, 'this week')}>Apply to this week</button>
          <button className="btn" disabled={!saved?.baseline || dirty || busy} title={applyTitle} onClick={() => void apply(addDays(now, 7), 'next week')}>Apply to next week</button>
        </div>
      </div>
      {showVersions && (
        <div className="baseline-versions">
          {versions.map((v) => (
            <div key={v.version} className="task-row">
              <span className="name">Version {v.version}{v.version === savedVersion ? ' (current)' : ''}</span>
              <span className="meta">{fmtSaved(v.savedAt)}</span>
              <button className="btn" disabled={v.version === savedVersion || busy} onClick={() => void revert(v.version)}>Revert</button>
            </div>
          ))}
        </div>
      )}
      {newer !== null && <div className="hint baseline-note">A newer baseline (v{newer}) was saved; Save will overwrite it, Discard loads it.</div>}
      {note && <div className="hint baseline-note">{note}</div>}
      <CalendarView days={days} now={now} blocks={blocks} commitments={commitments} recurring={[]} tasks={tasks} settings={settings} onChanged={noop} template={editor} />
    </div>
  );
}
