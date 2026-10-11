import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import { fmtMinutes, fmtTime } from '../time.js';

export interface CardProps {
  id: string;
  title: string;
  color: string;
  start: Date;
  end: Date;
  status?: 'pending' | 'done' | 'skipped' | 'missed' | 'commitment';
  top: number; height: number; col: number; cols: number;
  dragging?: boolean;
  /** Default: every card but a commitment. */
  resizable?: boolean;
  running?: boolean;
  elapsed?: number;
  /** The block carries a note from the user. */
  noted?: boolean;
  onPointerDown?: (e: PointerEvent<HTMLDivElement>, mode: 'move' | 'resize') => void;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function BlockCard(p: CardProps) {
  const width = 100 / p.cols;
  const style: CSSProperties = {
    top: p.top, height: Math.max(p.height - 2, 14), left: `calc(${p.col * width}% + 2px)`, width: `calc(${width}% - 4px)`,
    ['--c' as string]: p.color,
  };
  const cls = ['card', p.status ?? 'pending', p.dragging ? 'dragging' : '', p.running ? 'running' : ''].join(' ');
  const resizable = p.resizable ?? p.status !== 'commitment';
  return (
    <div className={cls} style={style} title={`${p.title} ${fmtTime(p.start)}–${fmtTime(p.end)}`}
      onPointerDown={(e) => p.onPointerDown?.(e, 'move')} onClick={p.onClick} onContextMenu={p.onContextMenu}>
      <div className="title">
        <span className="name">{p.title}</span>
        {p.elapsed !== undefined && (p.elapsed > 0 || p.running) && <span className="badge">{p.running ? '● ' : ''}{fmtMinutes(p.elapsed)}</span>}
        {p.noted && <span className="badge" title="Has a note">✎</span>}
      </div>
      {p.height >= 30 && <div className="time">{fmtTime(p.start)} – {fmtTime(p.end)}</div>}
      {resizable && <div className="resize" onPointerDown={(e) => { e.stopPropagation(); p.onPointerDown?.(e, 'resize'); }} />}
    </div>
  );
}
