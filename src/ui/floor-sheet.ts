// The floor edit side sheet: the room list (one focusable entry per room, with keyboard moves and
// per-room controls), and the "Add room" select. DOM only; room and division names via textContent.
import { BULLPEN, type DivisionDef, type RoomDef } from '../shared/building.ts';
import { bandRooms, type Band } from './floor-edit.ts';

export const CUSTOM = ':custom'; // never a division id (ids can't contain ':')

export type RoomAction =
  | { k: 'select' }
  | { k: 'move'; dir: -1 | 1 }
  | { k: 'band'; band: Band }
  | { k: 'width'; by: number }
  | { k: 'remove' };

const SIDE: Record<Band, string> = { top: 'Top side', bottom: 'Bottom side' };

function iconBtn(label: string, text: string, cls: string, fn: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = `btn icon ${cls}`; b.textContent = text; b.disabled = disabled;
  b.setAttribute('aria-label', label); b.title = label;
  b.addEventListener('click', fn);
  return b;
}

/** Maps a key on a focused room to an edit, or null. Left/Right move, Up/Down change side, +/- resize, Delete removes. */
export function keyAction(e: KeyboardEvent, band: Band): RoomAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowLeft': return { k: 'move', dir: -1 };
    case 'ArrowRight': return { k: 'move', dir: 1 };
    case 'ArrowUp': return band === 'bottom' ? { k: 'band', band: 'top' } : null;
    case 'ArrowDown': return band === 'top' ? { k: 'band', band: 'bottom' } : null;
    case '+': case '=': return { k: 'width', by: 1 };
    case '-': case '_': return { k: 'width', by: -1 };
    case 'Delete': case 'Backspace': return { k: 'remove' };
    default: return null;
  }
}

/**
 * Renders the room list into `el`, grouped by side in layout order. The selected room's entry also
 * shows move/resize buttons (the touch and screen-reader alternative to dragging on the canvas).
 */
export function renderRoomList(el: HTMLElement, rooms: RoomDef[], divisions: Pick<DivisionDef, 'id' | 'color'>[], selected: string | undefined, act: (id: string, a: RoomAction) => void): void {
  const groups: HTMLElement[] = [];
  for (const band of ['top', 'bottom'] as const) {
    const rs = bandRooms(rooms, band);
    const h = document.createElement('h4'); h.textContent = SIDE[band];
    const ol = document.createElement('ol');
    ol.setAttribute('aria-label', SIDE[band]);
    rs.forEach((r, i) => {
      const li = document.createElement('li');
      li.dataset.room = r.id;
      const sel = r.id === selected;
      li.classList.toggle('selected', sel);
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'pick';
      pick.setAttribute('aria-pressed', String(sel));
      pick.setAttribute('aria-describedby', 'editHelp');
      pick.setAttribute('aria-label', `${r.name}, ${SIDE[band].toLowerCase()}, position ${i + 1} of ${rs.length}, ${r.width} wide`);
      const sw = document.createElement('span'); sw.className = 'swatch';
      const color = r.id === BULLPEN ? '#e0a96d' : divisions.find((d) => d.id === r.division)?.color;
      if (color) sw.style.background = color; else sw.classList.add('none');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = r.name;
      const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${r.width} wide`;
      pick.append(sw, name, meta);
      pick.addEventListener('click', () => act(r.id, { k: 'select' }));
      pick.addEventListener('focus', () => { if (!li.classList.contains('selected')) act(r.id, { k: 'select' }); });
      pick.addEventListener('keydown', (e) => {
        const a = keyAction(e, band);
        if (!a) return;
        e.preventDefault();
        act(r.id, a);
      });
      const bull = r.id === BULLPEN;
      const remove = iconBtn(bull ? 'The Bullpen always stays' : `Remove ${r.name}`, 'Remove', 'remove', () => act(r.id, { k: 'remove' }), bull);
      remove.classList.remove('icon');
      li.append(pick, remove);
      if (sel) {
        const ctl = document.createElement('div'); ctl.className = 'ctl';
        ctl.append(
          iconBtn(`Move ${r.name} left`, '←', 'mv-left', () => act(r.id, { k: 'move', dir: -1 }), i === 0),
          iconBtn(`Move ${r.name} right`, '→', 'mv-right', () => act(r.id, { k: 'move', dir: 1 }), i === rs.length - 1),
          iconBtn(`Move ${r.name} to the ${band === 'top' ? 'bottom' : 'top'} side`, band === 'top' ? '↓' : '↑', 'mv-band', () => act(r.id, { k: 'band', band: band === 'top' ? 'bottom' : 'top' })),
          iconBtn(`Make ${r.name} narrower`, '−', 'narrower', () => act(r.id, { k: 'width', by: -1 }), r.width <= 8),
          iconBtn(`Make ${r.name} wider`, '+', 'wider', () => act(r.id, { k: 'width', by: 1 }), r.width >= 24),
        );
        li.append(ctl);
      }
      ol.append(li);
    });
    if (!rs.length) { const e = document.createElement('li'); e.className = 'empty'; e.textContent = 'No rooms on this side.'; ol.append(e); }
    groups.push(h, ol);
  }
  el.replaceChildren(...groups);
}

/** Fills the "Add room" kind select: every division, then "Custom room". Keeps the choice if it still exists. */
export function renderAddKinds(sel: HTMLSelectElement, divisions: Pick<DivisionDef, 'id' | 'name'>[], rooms: RoomDef[]): void {
  const prev = sel.value;
  const opts = divisions.map((d) => {
    const o = document.createElement('option'); o.value = d.id; o.textContent = d.name;
    return o;
  });
  const custom = document.createElement('option'); custom.value = CUSTOM; custom.textContent = 'Custom room';
  sel.replaceChildren(...opts, custom);
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.value = divisions.find((d) => !rooms.some((r) => r.division === d.id))?.id ?? CUSTOM;
}
