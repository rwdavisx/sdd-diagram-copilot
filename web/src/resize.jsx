import { useState } from 'react';

// Draggable pane width: returns [width, onPointerDown for the divider].
// `fromRight` for panes anchored to the right edge (dragging left widens).
export function usePaneWidth(key, initial, { min = 260, max = 900, fromRight = false } = {}) {
  const [w, setW] = useState(() => Number(localStorage.getItem(key)) || initial);
  const onPointerDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    const width = (ev) => Math.min(max, Math.max(min, startW + (ev.clientX - startX) * (fromRight ? -1 : 1)));
    let last = startW;
    const move = (ev) => { last = width(ev); setW(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      localStorage.setItem(key, last);
    };
    document.body.style.userSelect = 'none'; // no text selection mid-drag
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [w, onPointerDown];
}
