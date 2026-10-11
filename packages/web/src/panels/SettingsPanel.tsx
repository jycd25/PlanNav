import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@ds/core';
import * as api from '../api.js';

/**
 * Settings: the week's first day, the assistant backend, calendar import (optionally as the baseline week) and export. Availability, budgets,
 * sessions, segments, work style and the daily cap come from the baseline week now, so they are not edited here.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function SettingsPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> | void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [kind, setKind] = useState<'anthropic' | 'claude-code'>('claude-code');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [asBaseline, setAsBaseline] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getSettings().then((r) => {
      setSettings(r.settings);
      setKind(r.assistant.kind);
      setModel(r.assistant.model ?? (r.assistant.kind === 'anthropic' ? 'claude-opus-5-5' : ''));
      setHasKey(r.assistant.hasApiKey);
    }).catch((e) => setStatus(String(e)));
  }, []);

  if (!settings) return <><div className="scrim" onClick={onClose} /><div className="sheet"><div className="sheet-body">Loading…</div></div></>;

  const save = async () => {
    try {
      const assistant = kind === 'anthropic'
        ? { kind, model: model || 'claude-opus-5-5', ...(apiKey ? { apiKey } : {}) }
        : { kind, ...(model ? { model } : {}) };
      await api.putSettings({ assistant });
      setStatus('Saved.');
      setApiKey('');
      if (kind === 'anthropic' && apiKey) setHasKey(true);
      await onChanged();
    } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };
  // Saved at once: it orders the Week view and the Baseline tab's columns, and decides which week "this week" is.
  const setWeekStart = async (weekStartsOn: number) => {
    try {
      const next = { ...settings, weekStartsOn };
      await api.putSettings({ settings: next });
      setSettings(next);
      setStatus(`The week starts on ${DAY_NAMES[weekStartsOn]}.`);
      await onChanged();
    } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };
  const doImport = async (source: { ics: string } | { url: string }) => {
    try {
      if (asBaseline) setStatus((await api.importAsBaseline(source)).summary);
      else {
        const r = 'ics' in source ? await api.importIcs(source.ics) : await api.importUrl(source.url);
        setStatus([r.summary, ...r.notes].join(' '));
      }
      if ('url' in source) setImportUrl('');
      await onChanged();
    } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };
  const doImportFile = async (file: File) => doImport({ ics: await file.text() });
  const doImportUrl = () => doImport({ url: importUrl });

  return (<>
    <div className="scrim" onClick={onClose} />
    <div className="sheet" role="dialog" aria-label="Settings">
      <div className="sheet-head"><span>Settings</span><button className="btn" onClick={onClose}>Close</button></div>
      <div className="sheet-body">
        <h3>Week</h3>
        <div className="field"><label>Week starts on</label>
          <select value={settings.weekStartsOn} onChange={(e) => void setWeekStart(Number(e.target.value))}>
            <option value={0}>Sunday</option><option value={1}>Monday</option>
            {settings.weekStartsOn !== 0 && settings.weekStartsOn !== 1 && <option value={settings.weekStartsOn}>{DAY_NAMES[settings.weekStartsOn]}</option>}
          </select>
        </div>

        <h3>Import</h3>
        <div className="hint">Google Calendar: Settings → your calendar → “Secret address in iCal format”. Re-import any time to refresh.</div>
        <label className="row"><input type="checkbox" checked={asBaseline} onChange={(e) => setAsBaseline(e.target.checked)} />Use as my baseline</label>
        <div className="hint">{asBaseline
          ? 'Makes the baseline week from the last 60 days: what repeats in at least half of the weeks becomes a slot, each title a task. Saved as a new baseline version.'
          : 'Adds the upcoming events as busy time.'}</div>
        <div className="row">
          <input style={{ flex: 1 }} value={importUrl} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" onChange={(e) => setImportUrl(e.target.value)} />
          <button className="btn" onClick={doImportUrl} disabled={!importUrl.trim()}>Fetch</button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => fileRef.current?.click()}>Import .ics file</button>
          <input ref={fileRef} type="file" accept=".ics,text/calendar" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImportFile(f); e.target.value = ''; }} />
          <span className="hint">Apple Calendar: File → Export → Export…</span>
        </div>

        <h3>Assistant</h3>
        <div className="field"><label>Backend</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'anthropic' | 'claude-code')}>
            <option value="claude-code">Claude Code subscription (claude -p)</option>
            <option value="anthropic">Anthropic API key (BYOK)</option>
          </select>
        </div>
        {kind === 'anthropic' && (<>
          <div className="field"><label>API key {hasKey && <span className="hint">(saved; leave blank to keep)</span>}</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" /></div>
          <div className="field"><label>Model</label><input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-opus-5-5" /></div>
        </>)}
        {kind === 'claude-code' && (
          <div className="field"><label>Model (optional alias: sonnet, opus)</label><input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" /></div>
        )}
        <div><button className="btn primary" onClick={save}>Save assistant</button></div>

        <h3>Export</h3>
        <div className="hint">Import the .ics into Google Calendar or Apple Calendar. The JSON holds everything.</div>
        <div className="row">
          <a className="btn" href="/api/export.ics" download>Download .ics</a>
          <a className="btn" href="/api/export.json" download="plannav.json">Download JSON</a>
        </div>

        {status && <div className="hint">{status}</div>}
      </div>
    </div>
  </>);
}
