// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BlockCard, type CardProps } from '../src/calendar/BlockCard.js';

afterEach(cleanup);

const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const base: CardProps = { id: 'b1', title: 'Leetcode', color: '#4f8cff', start: at(9), end: at(10, 30), top: 432, height: 72, col: 0, cols: 1 };

describe('BlockCard: the block as drawn on the grid', () => {
  it('shows the title, the time range when tall enough, and a tooltip with both', () => {
    render(<BlockCard {...base} />);
    const card = screen.getByTitle('Leetcode 09:00–10:30');
    expect(card.className).toBe('card pending  ');
    expect(card.querySelector('.name')!.textContent).toBe('Leetcode');
    expect(card.querySelector('.time')!.textContent).toBe('09:00 – 10:30');
  });

  it('hides the time line on a card under 30px and keeps a 14px minimum height', () => {
    render(<BlockCard {...base} height={12} />);
    const card = screen.getByTitle('Leetcode 09:00–10:30');
    expect(card.querySelector('.time')).toBeNull();
    expect(card.style.height).toBe('14px');
  });

  it('positions by column: width is a share of the day column, left is the column offset', () => {
    render(<BlockCard {...base} col={1} cols={2} />);
    const card = screen.getByTitle('Leetcode 09:00–10:30');
    expect(card.style.width).toBe('calc(50% - 4px)');
    expect(card.style.left).toBe('calc(50% + 2px)');
    expect(card.style.top).toBe('432px');
    expect(card.style.height).toBe('70px');
    expect(card.style.getPropertyValue('--c')).toBe('#4f8cff');
  });

  it('a zero-length block still has a visible 14px card', () => {
    render(<BlockCard {...base} end={at(9)} height={0} />);
    const card = screen.getByTitle('Leetcode 09:00–09:00');
    expect(card.style.height).toBe('14px');
  });

  it('status, dragging and running become class names', () => {
    render(<BlockCard {...base} status="done" dragging running />);
    expect(screen.getByTitle('Leetcode 09:00–10:30').className).toBe('card done dragging running');
  });

  it('a commitment has no resize handle; a block does; resizable overrides both', () => {
    const { unmount } = render(<BlockCard {...base} status="commitment" />);
    expect(document.querySelector('.resize')).toBeNull();
    unmount();
    render(<BlockCard {...base} />);
    expect(document.querySelector('.resize')).not.toBeNull();
    cleanup();
    render(<BlockCard {...base} status="commitment" resizable />);
    expect(document.querySelector('.resize')).not.toBeNull();
    cleanup();
    render(<BlockCard {...base} resizable={false} />);
    expect(document.querySelector('.resize')).toBeNull();
  });

  it('the elapsed badge appears for tracked minutes, with a dot while running, and never for 0 idle minutes', () => {
    render(<BlockCard {...base} elapsed={0} />);
    expect(document.querySelector('.badge')).toBeNull();
    cleanup();
    render(<BlockCard {...base} elapsed={85} />);
    expect(document.querySelector('.badge')!.textContent).toBe('1 h 25 min');
    cleanup();
    render(<BlockCard {...base} elapsed={0} running />);
    expect(document.querySelector('.badge')!.textContent).toBe('● 0 min');
  });

  it('a noted block shows the pencil badge with its tooltip', () => {
    render(<BlockCard {...base} noted />);
    const pencil = screen.getByTitle('Has a note');
    expect(pencil.textContent).toBe('✎');
    expect(pencil.className).toBe('badge');
  });

  it('pointer down on the body reports "move", on the handle "resize" without bubbling to the body', () => {
    const onPointerDown = vi.fn();
    render(<BlockCard {...base} onPointerDown={onPointerDown} />);
    const card = screen.getByTitle('Leetcode 09:00–10:30');
    fireEvent.pointerDown(card);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerDown.mock.calls[0][1]).toBe('move');
    fireEvent.pointerDown(card.querySelector('.resize')!);
    expect(onPointerDown).toHaveBeenCalledTimes(2);
    expect(onPointerDown.mock.calls[1][1]).toBe('resize');
  });

  it('click and context menu reach their handlers', () => {
    const onClick = vi.fn();
    const onContextMenu = vi.fn();
    render(<BlockCard {...base} onClick={onClick} onContextMenu={onContextMenu} />);
    const card = screen.getByTitle('Leetcode 09:00–10:30');
    fireEvent.click(card);
    fireEvent.contextMenu(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('a block crossing midnight shows its real end time in the tooltip', () => {
    render(<BlockCard {...base} start={at(23)} end={new Date(2026, 9, 8, 1)} />);
    expect(screen.getByTitle('Leetcode 23:00–01:00')).not.toBeNull();
  });
});
