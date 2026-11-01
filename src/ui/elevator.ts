// Elevator picker (a popover listbox: the Lobby, then floors) and the Lobby (the list of every floor
// that replaces the canvas). DOM only; names are owner/project text, so textContent only.
import type { FloorItem } from './state.ts';

export type { FloorItem };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function badge(needYou: number): HTMLElement | null {
  if (!needYou) return null;
  const b = document.createElement('span');
  b.className = 'needbadge';
  b.textContent = `${needYou} need${needYou === 1 ? 's' : ''} you`;
  return b;
}

let openState: { el: HTMLElement; anchor: HTMLElement; cleanup: () => void } | null = null;

export function pickerOpen(): boolean { return !!openState; }

export function closePicker(focusAnchor = true): void {
  if (!openState) return;
  const { el, anchor, cleanup } = openState;
  openState = null;
  cleanup();
  el.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (focusAnchor) anchor.focus();
}

/**
 * Opens the floor picker under `anchor`. Arrows/Home/End move, Enter picks, Esc closes; focus
 * returns to `anchor` on close. `current` is marked selected and starts active.
 */
export function openPicker(anchor: HTMLElement, items: FloorItem[], onPick: (id: string) => void, current?: string): void {
  closePicker(false);
  const list = document.createElement('ul');
  list.id = 'picker';
  list.className = 'picker';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Go to floor');
  list.tabIndex = -1;
  let active = Math.max(0, items.findIndex((i) => i.id === current));
  const opts = items.map((it, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `picker-opt-${i}`;
    li.dataset.id = it.id;
    li.setAttribute('aria-selected', String(it.id === current));
    const name = document.createElement('span'); name.className = 'name'; name.textContent = it.name;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = plural(it.agents, 'agent');
    li.append(name, count);
    const b = badge(it.needYou);
    if (b) li.append(b);
    li.addEventListener('mousemove', () => setActive(i));
    li.addEventListener('click', () => pick(i));
    return li;
  });
  list.append(...opts);
  function setActive(i: number): void {
    active = (i + opts.length) % opts.length;
    opts.forEach((o, j) => o.classList.toggle('active', j === active));
    list.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView?.({ block: 'nearest' });
  }
  function pick(i: number): void {
    const id = items[i].id;
    closePicker();
    onPick(id);
  }
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') setActive(active + 1);
    else if (e.key === 'ArrowUp') setActive(active - 1);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(opts.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') pick(active);
    else if (e.key === 'Escape' || e.key === 'Tab') { closePicker(); if (e.key === 'Tab') return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const outside = (e: MouseEvent) => { if (!list.contains(e.target as Node) && !anchor.contains(e.target as Node)) closePicker(false); };
  const away = () => closePicker(false);
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('resize', away);
  document.body.append(list);
  // Under the anchor, kept inside the viewport.
  const r = anchor.getBoundingClientRect(), pr = list.getBoundingClientRect();
  list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8))}px`;
  list.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - pr.height - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  openState = { el: list, anchor, cleanup: () => { document.removeEventListener('mousedown', outside, true); window.removeEventListener('resize', away); } };
  setActive(active);
  list.focus();
}

export interface LobbyOptions {
  /** Archived floors, listed under the live ones with Restore. */
  archived?: FloorItem[];
  /** Agents with no project yet (no floor). */
  unassigned?: number;
  /** Open a floor's management menu (Rename / Archive / Move) next to `btn`. */
  onMenu?: (id: string, btn: HTMLElement) => void;
  onRestore?: (id: string) => void;
  /** Shown instead of the list when there are no floors at all. */
  emptyText?: string;
  /** Placed above the floor list (the Bubbles card). Kept as is: the caller owns and updates it. */
  header?: HTMLElement;
}

/** Renders the Lobby into `container`: one row per floor (click to go there), each with a menu. */
export function renderLobby(container: HTMLElement, items: FloorItem[], onPick: (id: string) => void, o: LobbyOptions = {}): void {
  const h = document.createElement('h2'); h.textContent = 'Lobby';
  const sub = document.createElement('p'); sub.className = 'sub';
  sub.textContent = 'Every floor in the building. Pick one to take the elevator there.';
  const out: HTMLElement[] = [h, sub];
  if (o.header) out.push(o.header);
  const floors = items.filter((i) => i.id !== 'lobby');
  if (!floors.length && !o.archived?.length) {
    const p = document.createElement('p'); p.className = 'lobby-empty'; p.id = 'lobbyEmpty';
    p.textContent = o.emptyText ?? 'No floors yet.';
    out.push(p);
  }
  const row = (it: FloorItem, archived: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'lobby-row';
    li.dataset.id = it.id;
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'go';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = it.name;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = plural(it.agents, 'agent');
    go.append(name, count);
    const b = badge(it.needYou);
    if (b) go.append(b);
    go.addEventListener('click', () => onPick(it.id));
    li.append(go);
    if (archived) {
      const r = document.createElement('button');
      r.type = 'button'; r.className = 'btn restore'; r.textContent = 'Restore';
      r.setAttribute('aria-label', `Restore ${it.name}`);
      r.addEventListener('click', () => o.onRestore?.(it.id));
      li.append(r);
    } else if (o.onMenu) {
      const m = document.createElement('button');
      m.type = 'button'; m.className = 'more'; m.textContent = '⋯';
      m.setAttribute('aria-label', `Floor options for ${it.name}`);
      m.setAttribute('aria-haspopup', 'menu');
      m.addEventListener('click', () => o.onMenu!(it.id, m));
      li.append(m);
    }
    return li;
  };
  if (floors.length) {
    const ol = document.createElement('ol'); ol.className = 'lobby-list'; ol.id = 'lobbyFloors';
    ol.append(...floors.map((f) => row(f, false)));
    out.push(ol);
  }
  if (o.unassigned) {
    const p = document.createElement('p'); p.className = 'unassigned'; p.id = 'lobbyUnassigned';
    p.textContent = `Unassigned: ${plural(o.unassigned, 'agent')} with no project folder yet`;
    out.push(p);
  }
  if (o.archived?.length) {
    const h3 = document.createElement('h3'); h3.textContent = 'Archived floors';
    const ol = document.createElement('ol'); ol.className = 'lobby-list archived'; ol.id = 'lobbyArchived';
    ol.append(...o.archived.map((f) => row(f, true)));
    out.push(h3, ol);
  }
  container.replaceChildren(...out);
}
