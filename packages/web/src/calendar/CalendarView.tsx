import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Commitment, Settings, Task } from '@ds/core';
import * as api from '../api.js';
import type { BlockView, RecurringOccurrence } from '../api.js';
import { offHoursForDay } from './availability.js';
import { elapsedMinutes, fmtDayName, fmtMinutes, fmtTime, hourLabel, isSameDay } from '../time.js';
import { HOUR_PX, layoutDay, minutesToPx, pxToMinutes, rangeFromClick, rangeFromDrag, startsToday, timeRangeFromPx } from './layout.js';
import { clipFromBlock, pasteRange, type BlockClip } from './clipboard.js';
import { BlockCard } from './BlockCard.js';

/**
 * Template mode (the Baseline tab draws the template week on synthetic dates): every edit goes to these callbacks
 * instead of the server, ids are the editor's own, and dates, the now line, statuses and the clock are not shown.
 */
export interface TemplateEditor {
  move: (id: string, start: Date, end: Date) => void;
  addTask: (taskId: string, start: Date, end: Date) => void;
  addBusy: (title: string, start: Date, end: Date) => void;
  remove: (id: string) => void;
  setTask: (id: string, taskId: string) => void;
}

export interface CalendarViewProps {
  days: Date[]; now: Date; blocks: BlockView[]; commitments: Commitment[]; recurring: RecurringOccurrence[]; tasks: Task[]; settings: Settings;
  onChanged: () => Promise<void> | void;
  template?: TemplateEditor;
}

interface Drag { id: string; mode: 'move' | 'resize'; day: Date; startY: number; origTop: number; origHeight: number; top: number; height: number; moved: boolean }
interface Popover { block: BlockView; x: number; y: number }
interface CreateDrag { day: Date; y0: number; y1: number; colTop: number }
interface CreateForm { day: Date; start: Date; end: Date; x: number; y: number; kind: 'commitment' | 'weekly' | 'availability' | 'block' | 'paste'; title: string; taskId: string }
interface CommitmentPopover { id: string; title: string; recurringId?: string; x: number; y: number }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** The "Actual" field: prefilled once with the current elapsed minutes, so the one-second ticker never overwrites typing. */
function ActualMinutes({ initial, onLog }: { initial: number; onLog: (minutes: number) => void }) {
  const [value, setValue] = useState(String(initial));
  const minutes = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440;
  return (
    <div className="row">
      <label>Actual: <input type="number" min={0} max={1440} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && valid) onLog(Math.round(minutes)); }} /> min</label>
      <button className="btn" disabled={!valid} onClick={() => onLog(Math.round(minutes))}>Log</button>
    </div>
  );
}

/** The note on a block: the user's words for the assistant ("not focused", "two tasks shared this slot"). Saved on Save or Cmd/Ctrl+Enter. */
function BlockNote({ initial, onSave }: { initial: string; onSave: (note: string) => void }) {
  const [value, setValue] = useState(initial);
  const dirty = value.trim() !== initial.trim();
  return (
    <div className="note">
      <textarea aria-label="Note" placeholder="Note for the assistant: how it went, what to change…" value={value} maxLength={2000} rows={2}
        onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && dirty) onSave(value); }} />
      {dirty && <button className="btn" onClick={() => onSave(value)}>Save note</button>}
    </div>
  );
}

export function CalendarView({ days, now, blocks, commitments, recurring, tasks, settings, onChanged, template }: CalendarViewProps) {
  const defaultKind: CreateForm['kind'] = template ? 'block' : 'commitment';
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  // The click that follows a drag must not open the popover. React may clear `drag` before that click
  // arrives, so the guard lives in a ref that the click handler reads and resets.
  const suppressClickRef = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [createDrag, setCreateDrag] = useState<CreateDrag | null>(null);
  const createRef = useRef<CreateDrag | null>(null);
  createRef.current = createDrag;
  const [createForm, setCreateForm] = useState<CreateForm | null>(null);
  // Copy and paste of blocks: Copy in a block's popover (or Cmd/Ctrl+C while it is open), paste with Cmd/Ctrl+V at the pointer, or from the create form.
  const [clip, setClip] = useState<BlockClip | null>(null);
  const hoverRef = useRef<{ day: Date; minutes: number } | null>(null);
  const [commitmentPopover, setCommitmentPopover] = useState<CommitmentPopover | null>(null);

  // While a block's clock runs, re-render every second so its badge counts up. The server's clock is the record.
  const [tick, setTick] = useState(0);
  const anyRunning = blocks.some((b) => b.runningSince);
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);
  const clock = useMemo(() => new Date(), [tick, now]);

  // Drag on empty space: select a time range, then choose what to put there.
  const createActive = createDrag !== null;
  useEffect(() => {
    if (!createActive) return;
    const move = (e: PointerEvent) => {
      const c = createRef.current;
      if (!c) return;
      setCreateDrag({ ...c, y1: e.clientY - c.colTop });
    };
    const up = (e: PointerEvent) => {
      const c = createRef.current;
      setCreateDrag(null);
      if (!c) return;
      const y1 = e.clientY - c.colTop;
      if (Math.abs(y1 - c.y0) < 4) return;
      const { start, end } = rangeFromDrag(c.day, c.y0, y1, settings.slotMinutes, settings.minBlockMinutes);
      const body = bodyRef.current!;
      const rect = body.getBoundingClientRect();
      setCreateForm({ day: c.day, start, end, x: e.clientX - rect.left + body.scrollLeft, y: e.clientY - rect.top + body.scrollTop, kind: defaultKind, title: '', taskId: tasks[0]?.id ?? '' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [createActive, settings.slotMinutes, settings.minBlockMinutes, tasks, defaultKind]);

  const startCreate = (e: ReactPointerEvent<HTMLDivElement>, day: Date) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!(target.classList.contains('col') || target.classList.contains('line') || target.classList.contains('offhours'))) return;
    e.preventDefault();
    setPopover(null); setCommitmentPopover(null); setCreateForm(null);
    const colTop = e.currentTarget.getBoundingClientRect().top;
    setCreateDrag({ day, y0: e.clientY - colTop, y1: e.clientY - colTop, colTop });
  };

  // Right-click on empty space: "new" at that time, like Apple Calendar and Google Calendar.
  const openCreateAt = (e: React.MouseEvent<HTMLDivElement>, day: Date) => {
    const target = e.target as HTMLElement;
    if (!(target.classList.contains('col') || target.classList.contains('line') || target.classList.contains('offhours'))) return;
    e.preventDefault();
    setPopover(null); setCommitmentPopover(null); setCreateDrag(null);
    const colTop = e.currentTarget.getBoundingClientRect().top;
    const { start, end } = rangeFromClick(day, e.clientY - colTop, settings.slotMinutes, settings.minBlockMinutes);
    const body = bodyRef.current!;
    const rect = body.getBoundingClientRect();
    setCreateForm({ day, start, end, x: e.clientX - rect.left + body.scrollLeft, y: e.clientY - rect.top + body.scrollTop, kind: defaultKind, title: '', taskId: tasks[0]?.id ?? '' });
  };
  const popoverAt = (e: React.MouseEvent<HTMLElement>) => {
    const body = bodyRef.current!;
    const rect = body.getBoundingClientRect();
    return { x: e.clientX - rect.left + body.scrollLeft, y: e.clientY - rect.top + body.scrollTop };
  };

  const saveCreate = async () => {
    const f = createForm;
    if (!f) return;
    setCreateForm(null);
    if (f.kind === 'paste') { if (clip) await pasteAt(clip, f.day, f.start.getHours() * 60 + f.start.getMinutes()); return; }
    if (template) {
      if (f.kind === 'block' && f.taskId) template.addTask(f.taskId, f.start, f.end);
      else if (f.kind === 'commitment') template.addBusy(f.title.trim() || 'Busy', f.start, f.end);
      return;
    }
    try {
      if (f.kind === 'commitment') await api.addCommitment({ title: f.title.trim() || 'Busy', start: f.start.toISOString(), end: f.end.toISOString() });
      else if (f.kind === 'weekly') await api.addRecurring({ title: f.title.trim() || 'Busy', days: [f.day.getDay()], start: hhmm(f.start), end: hhmm(f.end) });
      else if (f.kind === 'availability') await api.putSettings({ settings: { ...settings, availability: [...settings.availability, { days: [f.day.getDay()], start: hhmm(f.start), end: hhmm(f.end) }] } });
      else if (f.kind === 'block' && f.taskId) await api.createBlock({ taskId: f.taskId, start: f.start.toISOString(), end: f.end.toISOString() });
    } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };

  const removeCommitment = async (p: CommitmentPopover) => {
    setCommitmentPopover(null);
    if (template) { template.remove(p.id); return; }
    try {
      if (p.recurringId) await api.deleteRecurring(p.recurringId);
      else await api.deleteCommitment(p.id);
    } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };
  const colorOf = useMemo(() => new Map(tasks.map((t) => [t.id, t.color])), [tasks]);

  // Scroll so that the earliest availability window (in template mode, the earliest slot) starts near the top on first render.
  const templateStarts = template ? [...blocks, ...commitments].map((x) => { const d = new Date(x.start); return d.getHours() * 60 + d.getMinutes(); }) : [];
  const firstStart = template ? (templateStarts.length ? Math.min(...templateStarts) : 9 * 60)
    : settings.availability.length ? Math.min(...settings.availability.map((w) => toMin(w.start))) : 9 * 60;
  useEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollTop === 0) el.scrollTop = Math.max(0, minutesToPx(firstStart) - 8);
  }, [firstStart]);

  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;
    const move = (e: PointerEvent) => {
      const d0 = dragRef.current;
      if (!d0) return;
      const dy = e.clientY - d0.startY;
      const moved = d0.moved || Math.abs(dy) > 3;
      if (moved) suppressClickRef.current = true;
      setDrag((d) => d && ({ ...d, moved,
        top: d.mode === 'move' ? Math.max(0, d.origTop + dy) : d.origTop,
        height: d.mode === 'resize' ? Math.max(minutesToPx(settings.slotMinutes), d.origHeight + dy) : d.origHeight }));
    };
    const up = async () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || !d.moved) { suppressClickRef.current = false; return; }
      const { start, end } = timeRangeFromPx(d.day, d.top, d.height, settings.slotMinutes);
      if (template) { template.move(d.id, start, end); return; }
      try { await api.patchBlock(d.id, { start: start.toISOString(), end: end.toISOString() }); } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
      await onChanged();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [dragActive, settings.slotMinutes, onChanged, template]);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, mode: 'move' | 'resize', id: string, day: Date, top: number, height: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPopover(null);
    setDrag({ id, mode, day, startY: e.clientY, origTop: top, origHeight: height, top, height, moved: false });
  };

  const setStatus = async (id: string, status: BlockView['status']) => {
    setPopover(null);
    try { await api.patchBlock(id, { status }); } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };
  const remove = async (id: string) => {
    setPopover(null);
    if (template) { template.remove(id); return; }
    try { await api.deleteBlock(id); } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };

  const pasteAt = async (c: BlockClip, day: Date, minutesOfDay: number) => {
    const { start, end } = pasteRange(c, day, minutesOfDay, settings.slotMinutes);
    if (template) { template.addTask(c.taskId, start, end); return; }
    try { await api.createBlock({ taskId: c.taskId, start: start.toISOString(), end: end.toISOString() }); } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };
  const copyBlock = (b: BlockView) => { setClip(clipFromBlock(b)); setPopover(null); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'c' && popover) { e.preventDefault(); copyBlock(popover.block); }
      if (e.key === 'v' && clip && hoverRef.current) { e.preventDefault(); void pasteAt(clip, hoverRef.current.day, hoverRef.current.minutes); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const saveNote = async (id: string, note: string) => {
    try { await api.patchBlock(id, { note }); } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };
  const track = async (id: string, action: 'start' | 'pause' | 'finish' | 'set', minutes?: number) => {
    try { await api.trackBlock(id, action, minutes); } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    await onChanged();
  };

  const nowTop = minutesToPx(now.getHours() * 60 + now.getMinutes());

  return (
    <div className={`cal${template ? ' template' : ''}`} style={{ ['--cols' as string]: days.length }}>
      <div className="cal-head">
        <div />
        {days.map((d) => template ? (
          <div key={d.toISOString()} className="day">{DAY_NAMES[d.getDay()]}</div>
        ) : (
          <div key={d.toISOString()} className={`day${isSameDay(d, now) ? ' today' : ''}`}>
            {fmtDayName(d)}<br /><span className="num">{d.getDate()}</span>
          </div>
        ))}
      </div>
      <div className="cal-body" ref={bodyRef} onClick={() => { setPopover(null); setCommitmentPopover(null); }}>
        <div className="cal-grid">
          <div className="gutter">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => <div key={h} className="hour" style={{ top: h * HOUR_PX }}>{hourLabel(h)}</div>)}
          </div>
          {days.map((day) => {
            const items = [
              ...blocks.map((b) => ({ ...b, kind: 'block' as const })),
              ...commitments.map((c) => ({ ...c, kind: 'commitment' as const })),
              ...recurring.map((r) => ({ id: `rec:${r.recurringId}:${r.start}`, title: r.title, start: r.start, end: r.end, kind: 'commitment' as const, recurringId: r.recurringId })),
            ];
            const positioned = layoutDay(items, day);
            const byId = new Map(items.map((i) => [i.id, i]));
            const off = template ? [] : offHoursForDay(settings.availability, day.getDay());
            const today = !template && isSameDay(day, now);
            return (
              <div key={day.toISOString()} className={`col${today ? ' today' : ''}`} onPointerDown={(e) => startCreate(e, day)} onContextMenu={(e) => openCreateAt(e, day)}
                onPointerMove={(e) => { hoverRef.current = { day, minutes: pxToMinutes(e.clientY - e.currentTarget.getBoundingClientRect().top) }; }} onPointerLeave={() => { hoverRef.current = null; }}>
                {Array.from({ length: 24 }, (_, h) => <div key={h} className="line" style={{ top: h * HOUR_PX }} />)}
                {off.map(([s, e]) => <div key={s} className="offhours" style={{ top: minutesToPx(s), height: minutesToPx(e - s) }} />)}
                {positioned.map((p) => {
                  const it = byId.get(p.id)!;
                  const isDragging = drag?.id === p.id;
                  const top = isDragging ? drag.top : p.top;
                  const height = isDragging ? drag.height : p.height;
                  if (it.kind === 'commitment') {
                    const recurringId = (it as { recurringId?: string }).recurringId;
                    return <BlockCard key={p.id} id={p.id} title={it.title} color="#8e8e93" start={new Date(it.start)} end={new Date(it.end)} status="commitment" top={top} height={height} col={p.col} cols={p.cols}
                      dragging={isDragging} resizable={!!template}
                      onPointerDown={(e, mode) => { e.stopPropagation(); if (template) startDrag(e, mode, p.id, day, p.top, p.height); }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        setPopover(null); setCommitmentPopover({ id: it.id, title: it.title, recurringId, ...popoverAt(e) });
                      }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPopover(null); setCommitmentPopover({ id: it.id, title: it.title, recurringId, ...popoverAt(e) }); }} />;
                  }
                  return (
                    <BlockCard key={p.id} id={p.id} title={it.taskName} color={colorOf.get(it.taskId) ?? '#4f8cff'} start={new Date(it.start)} end={new Date(it.end)}
                      status={it.status} top={top} height={height} col={p.col} cols={p.cols} dragging={isDragging}
                      running={!!it.runningSince} elapsed={elapsedMinutes(it, clock)} noted={!!it.note}
                      onPointerDown={(e, mode) => startDrag(e, mode, p.id, day, p.top, p.height)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        setCommitmentPopover(null);
                        setPopover({ block: it, ...popoverAt(e) });
                      }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCommitmentPopover(null); setPopover({ block: it, ...popoverAt(e) }); }} />
                  );
                })}
                {createDrag && isSameDay(createDrag.day, day) && (
                  <div className="ghost" style={{ top: Math.min(createDrag.y0, createDrag.y1), height: Math.max(2, Math.abs(createDrag.y1 - createDrag.y0)) }} />
                )}
                {today && <div className="nowline" style={{ top: nowTop }} />}
              </div>
            );
          })}
        </div>
        {commitmentPopover && (
          <div className="popover" style={{ left: Math.min(commitmentPopover.x, (bodyRef.current?.clientWidth ?? 400) - 220), top: commitmentPopover.y }} onClick={(e) => e.stopPropagation()}>
            <h4>{commitmentPopover.title}</h4>
            <div className="meta">{template ? 'Busy slot' : commitmentPopover.recurringId ? 'Every week' : 'Commitment'}</div>
            <div className="row">
              <button className="btn danger" onClick={() => removeCommitment(commitmentPopover)}>{commitmentPopover.recurringId ? 'Remove weekly rule' : 'Delete'}</button>
              <button className="btn" onClick={() => setCommitmentPopover(null)}>Close</button>
            </div>
          </div>
        )}
        {createForm && (
          <div className="popover create" style={{ left: Math.min(createForm.x, (bodyRef.current?.clientWidth ?? 400) - 260), top: createForm.y }} onClick={(e) => e.stopPropagation()}>
            <h4>{DAY_NAMES[createForm.day.getDay()]} {hhmm(createForm.start)} – {hhmm(createForm.end)}</h4>
            <div className="choices">
              {(template
                ? [['block', 'Task slot…'], ['commitment', 'Busy slot…']] as const
                : [['commitment', 'Busy once'], ['weekly', `Busy every ${DAY_NAMES[createForm.day.getDay()]}`], ['availability', `Available every ${DAY_NAMES[createForm.day.getDay()]}`], ['block', 'Task block']] as const
              ).map(([kind, label]) => (
                <label key={kind}><input type="radio" name="create-kind" checked={createForm.kind === kind} onChange={() => setCreateForm({ ...createForm, kind })} />{label}</label>
              ))}
              {clip && <label><input type="radio" name="create-kind" checked={createForm.kind === 'paste'} onChange={() => setCreateForm({ ...createForm, kind: 'paste' })} />Paste “{clip.taskName}” ({fmtMinutes(clip.minutes)})</label>}
            </div>
            {(createForm.kind === 'commitment' || createForm.kind === 'weekly') && (
              <input autoFocus value={createForm.title} placeholder="Title (e.g. Standup)" onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void saveCreate(); }} />
            )}
            {createForm.kind === 'block' && (
              tasks.length ? (
                <select value={createForm.taskId} onChange={(e) => setCreateForm({ ...createForm, taskId: e.target.value })}>
                  {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              ) : <div className="hint">No tasks yet. Add one in Tasks or ask the assistant.</div>
            )}
            <div className="row">
              <button className="btn primary" onClick={() => void saveCreate()} disabled={createForm.kind === 'block' && !createForm.taskId}>Add</button>
              <button className="btn" onClick={() => setCreateForm(null)}>Cancel</button>
            </div>
          </div>
        )}
        {popover && (() => {
          // The popover keeps its place after a tracking action; read the block's live state, not the snapshot taken at click time.
          const block = blocks.find((b) => b.id === popover.block.id) ?? popover.block;
          if (template) {
            const left = Math.min(popover.x, (bodyRef.current?.clientWidth ?? 400) - 220);
            return (
              <div className="popover create" style={{ left, top: popover.y }} onClick={(e) => e.stopPropagation()}>
                <h4>{DAY_NAMES[new Date(block.start).getDay()]} {fmtTime(new Date(block.start))} – {fmtTime(new Date(block.end))}</h4>
                <select aria-label="Task" value={block.taskId} onChange={(e) => { template.setTask(block.id, e.target.value); setPopover(null); }}>
                  {!tasks.some((t) => t.id === block.taskId) && <option value={block.taskId}>{block.taskName}</option>}
                  {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <div className="row">
                  <button className="btn" title="Copy this slot (⌘C); paste with ⌘V at the pointer or from the right-click menu" onClick={() => copyBlock(block)}>Copy</button>
                  <button className="btn danger" onClick={() => void remove(block.id)}>Delete</button>
                  <button className="btn" onClick={() => setPopover(null)}>Close</button>
                </div>
              </div>
            );
          }
          const running = !!block.runningSince;
          const started = !!block.startedAt || running || block.trackedMinutes !== undefined;
          // Start works on any pending block, whatever day it is planned on (the block stays; the clock records the actual start).
          // Finish needs today's block or one that was started. Reset undoes the status and the clock.
          const canStart = block.status === 'pending' && !running;
          const canFinish = block.status === 'pending' && (started || startsToday(block.start, new Date()));
          const canReset = block.status !== 'pending' || started;
          const actual = [block.startedAt ? `started ${fmtTime(new Date(block.startedAt))}` : '', block.finishedAt ? `finished ${fmtTime(new Date(block.finishedAt))}` : ''].filter(Boolean).join(' · ');
          return (
            <div className="popover" style={{ left: Math.min(popover.x, (bodyRef.current?.clientWidth ?? 400) - 220), top: popover.y }} onClick={(e) => e.stopPropagation()}>
              <h4>{block.taskName}</h4>
              <div className="meta">{fmtTime(new Date(block.start))} – {fmtTime(new Date(block.end))} · {block.status}{actual ? ` · ${actual}` : ''}</div>
              <div className="row">
                <button className="btn primary" onClick={() => setStatus(block.id, 'done')}>Done</button>
                <button className="btn" onClick={() => setStatus(block.id, 'skipped')}>Skip</button>
                {canReset && <button className="btn" title="Undo the status and the clock" onClick={() => setStatus(block.id, 'pending')}>Reset</button>}
                <button className="btn" title="Copy this block (⌘C); paste with ⌘V at the pointer or from the right-click menu" onClick={() => copyBlock(block)}>Copy</button>
                <button className="btn danger" onClick={() => remove(block.id)}>Delete</button>
              </div>
              <div className="row">
                {canStart && <button className="btn" onClick={() => void track(block.id, 'start')}>Start</button>}
                {running && <button className="btn" onClick={() => void track(block.id, 'pause')}>Pause</button>}
                {canFinish && <button className="btn" onClick={() => void track(block.id, 'finish')}>Finish</button>}
              </div>
              <ActualMinutes key={`${block.id}:${block.trackedMinutes ?? 0}:${block.runningSince ?? ''}`} initial={elapsedMinutes(block, new Date())} onLog={(m) => void track(block.id, 'set', m)} />
              <BlockNote key={`note:${block.id}:${block.note ?? ''}`} initial={block.note ?? ''} onSave={(note) => void saveNote(block.id, note)} />
            </div>
          );
        })()}
      </div>
    </div>
  );
}
