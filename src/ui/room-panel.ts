// The room panel: a door sign opens it. Sets up one room's harness, either for this room on this floor (an override) or
// for its division everywhere, and offers the MCP catalog, skill library and "Start agent here". Everything agents, the
// CLI or files wrote is set with textContent only; secret values never reach the office, only the names that are set.
import { secretRefs, type McpServerDef } from '../shared/catalog.ts';
import type { DivisionDef, RoomDef } from '../shared/building.ts';
import { PROMPT_MAX, effective, mergeHarness, type Harness, type PermissionMode } from '../shared/harness.ts';
import { cleanText, type OfficeState } from './state.ts';
import { post } from './panel.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export type Scope = 'room' | 'division';
export const MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'];
export const TOOL_CHOICES = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite', 'NotebookEdit'];
export const PERMISSION_LABELS: Record<PermissionMode, string> = { auto: 'Auto', acceptEdits: 'Accept edits', manual: 'Manual', plan: 'Plan' };
const OTHER = '__other';
const CONFLICT_TEXT = 'This room\'s setup changed elsewhere. Reload to see the latest.';
const DISCARD_TEXT = 'You have unsaved changes. Save them, or do that again to discard them.';
const EXPIRED_TEXT = 'Your office login expired. Restart the server for a new login link.';

export interface HarnessRow { field: string; value: string; from: 'division' | 'room' | 'default' }

/** One row per setting (one per entry for lists) and where it comes from. Follows the merge: removals and deny > ask > allow apply. */
export function harnessRows(division: Harness | undefined, override: Harness | undefined): HarnessRow[] {
  const d = division ?? {}, o = override ?? {};
  const rows: HarnessRow[] = [];
  const scalar = (field: string, key: 'inherit' | 'model' | 'permission_mode' | 'prompt_mode', dflt: string) => {
    if (o[key] !== undefined) rows.push({ field, value: String(o[key]), from: 'room' });
    else if (d[key] !== undefined) rows.push({ field, value: String(d[key]), from: 'division' });
    else rows.push({ field, value: dflt, from: 'default' });
  };
  scalar('inherit', 'inherit', 'true');
  scalar('model', 'model', 'Default');
  scalar('permission_mode', 'permission_mode', 'Default');
  scalar('prompt_mode', 'prompt_mode', 'append');
  const replaced = o.prompt_mode === 'replace' && o.prompt !== undefined;
  if (d.prompt !== undefined && !replaced) rows.push({ field: 'prompt', value: d.prompt, from: 'division' });
  if (o.prompt !== undefined) rows.push({ field: 'prompt', value: o.prompt, from: 'room' });
  if (d.prompt === undefined && o.prompt === undefined) rows.push({ field: 'prompt', value: 'None', from: 'default' });
  const merged = effective(mergeHarness(d, o));
  const list = (field: 'tools' | 'allow' | 'ask' | 'deny' | 'mcp' | 'skills', values: string[]) => {
    for (const value of values) rows.push({ field, value, from: (o[field] ?? []).includes(value) ? 'room' : 'division' });
  };
  if (merged.tools === undefined) rows.push({ field: 'tools', value: 'Default set', from: 'default' });
  else if (merged.tools.length === 0) rows.push({ field: 'tools', value: 'None', from: o.tools ? 'room' : 'division' });
  else list('tools', merged.tools);
  list('allow', merged.allow); list('ask', merged.ask); list('deny', merged.deny);
  list('mcp', merged.mcp); list('skills', merged.skills);
  return rows;
}

/** What the form shows: this scope's own values, with lists merged where the panel can only show the result (tools, MCP, skills). */
export interface RoomForm {
  clean: boolean; model: string; mode: PermissionMode | ''; prompt: string; toolsOnly: boolean; tools: string[];
  allow: string[]; ask: string[]; deny: string[]; mcp: string[]; skills: string[];
}

export function formFrom(own: Harness, inherited: Harness | undefined): RoomForm {
  const merged = effective(mergeHarness(inherited ?? {}, own));
  return {
    clean: (own.inherit ?? inherited?.inherit ?? true) === false,
    model: own.model ?? '',
    mode: own.permission_mode ?? '',
    prompt: own.prompt ?? '',
    toolsOnly: merged.tools !== undefined,
    tools: merged.tools ?? [],
    allow: own.allow ?? [], ask: own.ask ?? [], deny: own.deny ?? [],
    mcp: merged.mcp, skills: merged.skills,
  };
}

/** The harness to store for this scope: only what differs from `inherited`, plus the keys the panel does not edit. */
export function harnessFrom(f: RoomForm, own: Harness, inherited: Harness | undefined): Harness {
  const h: Harness = {};
  if (own.prompt_mode !== undefined) h.prompt_mode = own.prompt_mode;
  if (own.optional !== undefined) h.optional = own.optional;
  if (inherited) { if (f.clean !== ((inherited.inherit ?? true) === false)) h.inherit = !f.clean; }
  else if (f.clean) h.inherit = false;
  if (f.model) h.model = f.model;
  if (f.mode) h.permission_mode = f.mode;
  if (f.prompt.trim()) h.prompt = f.prompt;
  if (f.toolsOnly) {
    const base = inherited?.tools ?? [];
    const out = [...f.tools.filter((t) => !base.includes(t)), ...base.filter((t) => !f.tools.includes(t)).map((t) => `-${t}`)];
    if (out.length > 0 || !inherited?.tools) h.tools = out;
  }
  for (const k of ['allow', 'ask', 'deny'] as const) if (f[k].length > 0) h[k] = f[k];
  const names = (key: 'mcp' | 'skills'): void => {
    const base = effective(inherited ?? {})[key];
    const out = [...f[key].filter((n) => !base.includes(n)), ...base.filter((n) => !f[key].includes(n)).map((n) => `-${n}`)];
    if (out.length > 0) h[key] = out;
  };
  names('mcp'); names('skills');
  return h;
}

/** The Default choice names the mode the room would really get: its division's, else the office setting. */
export const defaultModeLabel = (inherited: PermissionMode | undefined, divName: string, global: PermissionMode): string =>
  (inherited ? `Default (${PERMISSION_LABELS[inherited]}, from ${divName})` : `Default (${PERMISSION_LABELS[global]}, office setting)`);

/** Shown while "Only these" has nothing checked, so an agent with no tools is never a surprise. */
export const toolsWarning = (toolsOnly: boolean, tools: string[], scope: Scope, divName: string): string =>
  (!toolsOnly || tools.length > 0 ? '' : `Nothing is checked: agents in ${scope === 'room' ? 'this room' : `${divName} rooms`} will start with no tools at all.`);

/** The note over a room's prompt: the division's text, or that this room's prompt replaces it (prompt_mode: replace). */
export function promptNote(divName: string, inherited: string | undefined, prompt: string, mode: Harness['prompt_mode']): string {
  if (!inherited) return '';
  return mode === 'replace' && prompt.trim() ? `Replaces the prompt from ${divName}: ${inherited}` : `from ${divName}: ${inherited}`;
}

/** Secrets this server refers to that are not set. */
export const needsSecrets = (def: McpServerDef, set: readonly string[]): string[] => secretRefs(def).filter((s) => !set.includes(s));

const shellWord = (s: string): string => (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
/** The command that starts this room's harness from a terminal. */
export const runCommand = (room: string, project: string): string => `kubicle run ${shellWord(room)} --project ${shellWord(project)}`;

const lines = (s: string): string[] => [...new Set(s.split('\n').map((l) => l.trim()).filter(Boolean))];
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = cleanText(text);
  return e;
};

export interface RoomPanelOptions {
  floorName(id: string): string;
  rooms(floor: string): RoomDef[];
  /** "Start agent here": the panel has closed. */
  onStart(room: string, opener: HTMLElement | null): void;
}

type TestState = { busy: boolean; ok: boolean; text: string };

export class RoomPanelUi {
  #state: OfficeState;
  #o: RoomPanelOptions;
  #dlg = $<HTMLDialogElement>('roomPanel');
  #form = $<HTMLFormElement>('rpForm');
  #fields = $<HTMLFieldSetElement>('rpFields');
  #opener: HTMLElement | null = null;
  #floor = '';
  #room: RoomDef | null = null;
  #readOnly = false;
  #scope: Scope = 'room';
  #base = JSON.stringify(formFrom({}, undefined));
  #baseRevision = 0;
  /** The division harness the form was built from: a change makes the form's diff wrong, as a revision change does. */
  #inheritedKey = 'null';
  #saving = false;
  #warned = false;
  #tests = new Map<string, TestState>();
  #imports = new Map<string, { busy: boolean; msg: string }>();

  constructor(state: OfficeState, o: RoomPanelOptions) {
    this.#state = state;
    this.#o = o;
    $('rpClose').addEventListener('click', () => this.#tryClose());
    this.#dlg.addEventListener('cancel', (e) => { if (this.#blockDiscard()) e.preventDefault(); });
    this.#dlg.addEventListener('close', () => this.#closed());
    // A click on the backdrop (outside the panel box) closes it.
    this.#dlg.addEventListener('mousedown', (e) => { if (e.target === this.#dlg) { const r = this.#dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.#tryClose(); } });
    $('rpStart').addEventListener('click', () => { const room = this.#room; if (room && !this.#blockDiscard()) { const o = this.#opener; this.close(false); this.#o.onStart(room.id, o); } });
    $('rpCopy').addEventListener('click', () => void this.#copy());
    for (const r of [$<HTMLInputElement>('rpScopeRoom'), $<HTMLInputElement>('rpScopeDivision')]) r.addEventListener('change', () => this.#scopeChanged(r.value as Scope));
    this.#form.addEventListener('submit', (e) => { e.preventDefault(); void this.#save(); });
    this.#form.addEventListener('input', () => this.#userEdited());
    this.#form.addEventListener('change', () => this.#userEdited());
    $('rpReload').addEventListener('click', () => { this.#load(); $('rpClean').focus(); });
    $('rpImportBtn').addEventListener('click', () => this.#toggleImport());
    $('rpMcpForm').addEventListener('submit', (e) => { e.preventDefault(); void this.#addMcp(); });
    $('rpMcpType').addEventListener('change', () => this.#syncMcpType());
    $('rpMcpAddPair').addEventListener('click', () => this.#addPair());
  }

  get isOpen(): boolean { return this.#dlg.open; }

  open(roomId: string, opener: HTMLElement | null): void {
    if (this.#dlg.open) return;
    const floor = this.#state.currentFloor;
    const room = this.#o.rooms(floor).find((r) => r.id === roomId);
    if (!room) return;
    this.#opener = opener;
    this.#floor = floor; this.#room = room;
    this.#readOnly = !!this.#state.project(floor)?.archived;
    this.#scope = 'room';
    this.#tests.clear(); this.#imports.clear();
    $('rpImportList').hidden = true;
    $('rpImportBtn').setAttribute('aria-expanded', 'false');
    this.#resetMcpForm();
    this.#load();
    this.#dlg.showModal();
    this.#dlg.scrollTop = 0;
    $('rpClose').focus();
  }

  close(restoreFocus = true): void {
    if (!this.#dlg.open) return;
    if (!restoreFocus) this.#opener = null;
    this.#dlg.close();
  }

  #tryClose(): void { if (!this.#blockDiscard()) this.close(); }

  #closed(): void {
    if (this.#dlg.open) return; // the close event is queued: it can arrive after a quick reopen
    this.#room = null;
    const o = this.#opener;
    this.#opener = null;
    o?.focus?.();
  }

  /** True when the first attempt to throw away unsaved edits should be stopped with a note. */
  #blockDiscard(): boolean {
    if (this.#warned || this.#readOnly || !this.#dirty()) return false;
    this.#warned = true;
    this.#msg(DISCARD_TEXT);
    return true;
  }

  // ---------------------------------------------------------------- what this scope edits
  #division(): DivisionDef | undefined {
    const id = this.#room?.division;
    return id ? this.#state.building.divisions.find((d) => d.id === id) : undefined;
  }
  #override(): Harness {
    const f = this.#state.building.overrides[this.#floor], id = this.#room?.id ?? '';
    return f && Object.hasOwn(f.rooms, id) ? f.rooms[id]! : {};
  }
  #own(): Harness { return this.#scope === 'room' ? this.#override() : (this.#division()?.harness ?? {}) as Harness; }
  #inherited(): Harness | undefined { return this.#scope === 'room' ? this.#division()?.harness as Harness | undefined : undefined; }
  #revision(): number {
    return this.#scope === 'room' ? this.#state.building.overrides[this.#floor]?.revision ?? 0 : this.#division()?.revision ?? 0;
  }
  #inheritedNow(): string { return JSON.stringify(this.#inherited() ?? null); }
  #dirty(): boolean { return !!this.#room && JSON.stringify(this.#read()) !== this.#base; }

  // ---------------------------------------------------------------- render
  /** Fills every field from the server's state for the current scope. Unsaved edits are lost; callers check. */
  #load(): void {
    const room = this.#room;
    if (!room) return;
    const div = this.#division();
    $('rpTitle').textContent = cleanText(room.name);
    $('rpSub').textContent = cleanText(room.division ? `Division: ${div?.name ?? 'Unknown division'}` : 'No division');
    $('rpStart').hidden = $('rpCopy').hidden = this.#readOnly;
    $('rpArchived').hidden = !this.#readOnly;
    $('rpCmd').hidden = true;
    $('rpCopyNote').textContent = '';
    $('rpScopeRoomText').textContent = cleanText(`This room on ${this.#o.floorName(this.#floor)}`);
    $('rpScopeDivisionText').textContent = cleanText(`${div?.name ?? ''} everywhere`);
    $('rpScopeDivisionRow').hidden = !div;
    $('rpScope').hidden = !div;
    $<HTMLInputElement>('rpScopeRoom').checked = this.#scope === 'room';
    $<HTMLInputElement>('rpScopeDivision').checked = this.#scope === 'division';
    this.#fields.disabled = this.#readOnly;
    $<HTMLFieldSetElement>('rpMcpFields').disabled = this.#readOnly;
    $('rpMcpAdd').hidden = this.#readOnly;

    const f = formFrom(this.#own(), this.#inherited());
    this.#baseRevision = this.#revision();
    this.#inheritedKey = this.#inheritedNow();
    $<HTMLInputElement>('rpClean').checked = f.clean;
    const known = MODEL_CHOICES.includes(f.model) || f.model === '';
    $<HTMLSelectElement>('rpModel').value = known ? f.model : OTHER;
    $<HTMLInputElement>('rpModelOther').value = known ? '' : f.model;
    $<HTMLSelectElement>('rpMode').value = f.mode;
    const prompt = $<HTMLTextAreaElement>('rpPrompt');
    prompt.value = f.prompt; prompt.maxLength = PROMPT_MAX;
    $<HTMLInputElement>('rpToolsDefault').checked = !f.toolsOnly;
    $<HTMLInputElement>('rpToolsOnly').checked = f.toolsOnly;
    $<HTMLTextAreaElement>('rpAllow').value = f.allow.join('\n');
    $<HTMLTextAreaElement>('rpAsk').value = f.ask.join('\n');
    $<HTMLTextAreaElement>('rpDeny').value = f.deny.join('\n');
    this.#renderTools(f.tools);
    this.#renderMcp(f.mcp);
    this.#renderSkills(f.skills);
    this.#renderImports();
    this.#base = JSON.stringify(this.#read());
    this.#warned = false;
    this.#msg('');
    this.#sync();
  }

  /** The form as a RoomForm. Rule lists are normalized so an edit that changes nothing is not dirty. */
  #read(): RoomForm {
    const modelSel = $<HTMLSelectElement>('rpModel').value;
    const checked = (id: string) => [...$(id).querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((i) => i.dataset.name!);
    return {
      clean: $<HTMLInputElement>('rpClean').checked,
      model: modelSel === OTHER ? $<HTMLInputElement>('rpModelOther').value.trim() : modelSel,
      mode: $<HTMLSelectElement>('rpMode').value as PermissionMode | '',
      prompt: $<HTMLTextAreaElement>('rpPrompt').value,
      toolsOnly: $<HTMLInputElement>('rpToolsOnly').checked,
      tools: checked('rpTools'),
      allow: lines($<HTMLTextAreaElement>('rpAllow').value),
      ask: lines($<HTMLTextAreaElement>('rpAsk').value),
      deny: lines($<HTMLTextAreaElement>('rpDeny').value),
      mcp: checked('rpMcp'), skills: checked('rpSkills'),
    };
  }

  #userEdited(): void {
    this.#warned = false;
    if ($('rpMsg').textContent === DISCARD_TEXT) this.#msg('');
    this.#sync();
  }

  /** Everything that follows the form as it is typed: visibility, inherited/overridden notes, Save, the attribution list. */
  #sync(): void {
    const f = this.#read(), inh = this.#inherited(), divName = this.#scope === 'room' ? this.#division()?.name ?? '' : '';
    $('rpModelOtherRow').hidden = $<HTMLSelectElement>('rpModel').value !== OTHER;
    $('rpTools').hidden = !f.toolsOnly;
    const dflt = this.#state.building.settings.default_permission_mode;
    $<HTMLSelectElement>('rpMode').options[0]!.textContent = defaultModeLabel(inh?.permission_mode, divName, dflt);
    $<HTMLInputElement>('rpToolsDefault').disabled = !!inh?.tools;
    const roomScope = this.#scope === 'room';
    const scalar = (row: string, note: string, own: string, inherited: string | undefined) => {
      const over = roomScope && own !== '' && own !== undefined;
      this.#mark(row, over);
      if (roomScope && inherited !== undefined && own === '') this.#note(note, `from ${divName}: ${inherited}`, 'from');
      else if (over && inherited !== undefined) this.#note(note, `overrides ${divName}: ${inherited}`, 'set');
      else if (over) this.#note(note, 'set for this room', 'set');
      else this.#note(note, '', '');
    };
    const inhClean = (inh?.inherit ?? true) === false;
    if (inh && f.clean !== inhClean) { this.#mark('rpCleanRow', true); this.#note('rpCleanNote', inh.inherit !== undefined ? `overrides ${divName}` : 'set for this room', 'set'); }
    else if (inh?.inherit !== undefined) { this.#mark('rpCleanRow', false); this.#note('rpCleanNote', `from ${divName}`, 'from'); }
    else { this.#mark('rpCleanRow', roomScope && f.clean); this.#note('rpCleanNote', roomScope && f.clean ? 'set for this room' : '', 'set'); }
    scalar('rpModelRow', 'rpModelNote', f.model, inh?.model);
    scalar('rpModeRow', 'rpModeNote', f.mode, inh?.permission_mode ? PERMISSION_LABELS[inh.permission_mode] : undefined);
    this.#mark('rpPromptRow', roomScope && f.prompt.trim() !== '');
    const promptText = roomScope ? promptNote(divName, inh?.prompt, f.prompt, this.#own().prompt_mode) : '';
    this.#note('rpPromptNote', promptText, promptText.startsWith('Replaces') ? 'set' : 'from');
    const inhTools = inh?.tools ?? [];
    this.#mark('rpToolsRow', roomScope && (f.tools.some((t) => !inhTools.includes(t)) || inhTools.some((t) => !f.tools.includes(t))));
    this.#note('rpToolsNote', roomScope && inh?.tools ? `from ${divName}: ${inh.tools.join(', ')}. Uncheck one to remove it for this room.` : '', 'from');
    this.#note('rpToolsEmpty', toolsWarning(f.toolsOnly, f.tools, this.#scope, this.#division()?.name ?? ''), '');
    for (const [key, row, note] of [['allow', 'rpAllowRow', 'rpAllowNote'], ['ask', 'rpAskRow', 'rpAskNote'], ['deny', 'rpDenyRow', 'rpDenyNote']] as const) {
      this.#mark(row, roomScope && f[key].length > 0);
      this.#note(note, roomScope && inh?.[key]?.length ? `from ${divName}: ${inh[key].join(', ')}` : '', 'from');
    }
    this.#renderRows(f);
    this.#renderProblems(f);
    $<HTMLButtonElement>('rpSave').disabled = this.#saving || !this.#dirty();
    $('rpSave').textContent = this.#saving ? 'Saving…' : 'Save';
    $('rpSaveBar').hidden = this.#readOnly;
  }

  #mark(id: string, over: boolean): void { $(id).classList.toggle('over', over); }
  #note(id: string, text: string, kind: 'from' | 'set' | ''): void {
    const n = $(id);
    const t = cleanText(text);
    if (n.textContent !== t) n.textContent = t;
    n.hidden = !t;
    n.dataset.kind = kind;
  }

  #msg(text: string, conflict = false): void {
    const box = $('rpMsgBox'), m = $('rpMsg');
    m.textContent = cleanText(text);
    box.hidden = !text;
    $('rpReload').hidden = !conflict;
    box.dataset.tone = text === 'Saved.' ? 'ok' : 'err';
  }

  #renderRows(f: RoomForm): void {
    const div = this.#scope === 'room' ? this.#division() : undefined;
    const form = harnessFrom(f, this.#own(), this.#inherited());
    const rows = this.#scope === 'room' ? harnessRows(this.#inherited(), form) : harnessRows(form, undefined);
    const name = this.#scope === 'room' ? (div?.name ?? 'division') : (this.#division()?.name ?? 'division');
    $('rpRows').replaceChildren(...rows.map((r) => {
      const li = el('li', `rp-row ${r.from}`);
      li.append(el('span', 'rp-rk', r.field), el('span', 'rp-rv', r.value), el('span', 'rp-rf', r.from === 'room' ? 'this room' : r.from === 'division' ? `from ${name}` : 'default'));
      return li;
    }));
  }

  /** The same problems Start would report for what the form says (Review Focus 2). */
  #renderProblems(f: RoomForm): void {
    const b = this.#state.building;
    const out: string[] = [];
    const div = this.#room?.division;
    const slug = this.#state.project(this.#floor)?.slug;
    for (const w of b.warnings) {
      if (w.includes('mcp.yaml') || (div && w.includes(`/divisions/${div}.yaml`)) || (slug && /overrides[\\/]/.test(w) && w.includes(`${slug}.yaml`))) out.push(w);
    }
    if (this.#scope === 'room' && this.#own().tools?.some((t) => t.startsWith('-')) && !this.#inherited()?.tools?.length) out.push(`Room "${this.#room?.id}" removes tools but its division lists none`);
    for (const name of f.mcp) {
      if (!Object.hasOwn(b.mcp.servers, name)) { out.push(`MCP server "${name}" is not in mcp.yaml`); continue; }
      for (const s of needsSecrets(b.mcp.servers[name]!, b.secretsSet)) out.push(`Secret "${s}" is not set: run kubicle secret set ${s}`);
    }
    for (const name of f.skills) if (!b.skills.some((s) => s.name === name)) out.push(`Skill "${name}" is not in the skill library`);
    const box = $('rpProblems');
    box.hidden = out.length === 0;
    box.replaceChildren(...[...new Set(out)].map((p) => el('li', '', p)));
  }

  /** Redraws a checkbox list, keeping focus on the same control. */
  #draw(list: HTMLElement, rows: HTMLElement[]): void {
    const f = document.activeElement as HTMLElement | null;
    const keep = f && list.contains(f) ? { key: f.closest<HTMLElement>('li')?.dataset.key, cls: f.className } : null;
    list.replaceChildren(...rows);
    if (!keep?.key) return;
    const li = [...list.querySelectorAll<HTMLElement>('li')].find((x) => x.dataset.key === keep.key);
    li?.querySelector<HTMLElement>(`[class="${keep.cls}"]`)?.focus();
  }

  #checkRow(key: string, cls: string, name: string, checked: boolean, opts: { tag?: string } = {}): HTMLLIElement {
    const li = el('li', cls); li.dataset.key = key;
    if (opts.tag) li.classList.add('inherited');
    const label = el('label', 'rp-check');
    const input = el('input', 'rp-box'); input.type = 'checkbox'; input.dataset.name = name; input.checked = checked;
    label.append(input, el('span', 'rp-name', name));
    li.append(label);
    if (opts.tag) li.append(el('span', 'rp-tag', opts.tag));
    return li;
  }

  #renderTools(checked: string[]): void {
    const inh = this.#inherited()?.tools ?? [];
    const names = [...new Set([...TOOL_CHOICES, ...checked])]; // an entry from a hand-edited file stays visible
    const tag = this.#scope === 'room' ? `from ${this.#division()?.name ?? ''}` : undefined;
    this.#draw($('rpTools'), names.map((t) => this.#checkRow(t, 'rp-item', t, checked.includes(t), inh.includes(t) && tag ? { tag } : {})));
  }

  /** Secrets, new servers and test results change while the panel is open: redraw without touching what is checked. */
  #renderMcp(checked: string[]): void {
    const b = this.#state.building;
    const inhNames = effective(this.#inherited() ?? {}).mcp;
    const tag = this.#scope === 'room' ? `from ${this.#division()?.name ?? ''}` : undefined;
    const names = [...new Set([...Object.keys(b.mcp.servers).sort(), ...checked])];
    if (names.length === 0) { this.#draw($('rpMcp'), [el('li', 'empty', 'No MCP servers yet. Add one below.')]); return; }
    this.#draw($('rpMcp'), names.map((name) => {
      const def = Object.hasOwn(b.mcp.servers, name) ? b.mcp.servers[name]! : undefined;
      const li = this.#checkRow(name, 'rp-item mcp', name, checked.includes(name), inhNames.includes(name) && tag ? { tag } : {});
      if (!def) li.append(el('span', 'rp-need', 'not in mcp.yaml'));
      else for (const s of needsSecrets(def, b.secretsSet)) li.append(el('span', 'rp-need', `needs secret ${s} (not set)`));
      if (def) {
        const t = this.#tests.get(name);
        const btn = el('button', 'btn rp-test', t?.busy ? 'Testing…' : 'Test'); btn.type = 'button';
        btn.setAttribute('aria-label', `Test ${name}`);
        btn.setAttribute('aria-busy', String(!!t?.busy)); // not disabled: a disabled button would drop keyboard focus
        btn.addEventListener('click', () => void this.#test(name));
        li.append(btn);
        if (t && !t.busy) { const m = el('span', `rp-result ${t.ok ? 'ok' : 'err'}`, t.text); m.setAttribute('role', 'status'); li.append(m); }
      }
      return li;
    }));
  }

  #renderSkills(checked: string[]): void {
    const b = this.#state.building;
    const inhNames = effective(this.#inherited() ?? {}).skills;
    const tag = this.#scope === 'room' ? `from ${this.#division()?.name ?? ''}` : undefined;
    const names = [...new Set([...b.skills.map((s) => s.name).sort(), ...checked])];
    if (names.length === 0) { this.#draw($('rpSkills'), [el('li', 'empty', 'The skill library is empty. Import one to use it here.')]); return; }
    this.#draw($('rpSkills'), names.map((name) => {
      const li = this.#checkRow(name, 'rp-item', name, checked.includes(name), inhNames.includes(name) && tag ? { tag } : {});
      if (!b.skills.some((s) => s.name === name)) li.append(el('span', 'rp-need', 'not in the library'));
      return li;
    }));
  }

  #renderImports(): void {
    const b = this.#state.building;
    const rows = b.importable.filter((s) => !b.skills.some((x) => x.name === s.name));
    const list = $('rpImportList');
    if (rows.length === 0) { list.replaceChildren(el('li', 'empty', 'Nothing to import.')); return; }
    this.#draw(list, rows.map((s) => {
      const li = el('li', 'rp-item imp'); li.dataset.key = s.path;
      const st = this.#imports.get(s.path);
      const body = el('div', 'rp-imp');
      body.append(el('span', 'rp-name', s.name), el('span', 'rp-desc', s.description));
      const btn = el('button', 'btn rp-import', st?.busy ? 'Importing…' : 'Import'); btn.type = 'button';
      btn.setAttribute('aria-label', `Import ${s.name}`);
      btn.disabled = !!st?.busy;
      btn.addEventListener('click', () => void this.#import(s.path));
      li.append(body, btn);
      if (st?.msg) { const m = el('span', 'rp-result err', st.msg); m.setAttribute('role', 'alert'); li.append(m); }
      return li;
    }));
  }

  #toggleImport(): void {
    const list = $('rpImportList');
    list.hidden = !list.hidden;
    $('rpImportBtn').setAttribute('aria-expanded', String(!list.hidden));
    if (!list.hidden) this.#renderImports();
  }

  /** New catalog/library state from the server: redraw lists, keep what the owner has checked. */
  #redrawLists(): void {
    const f = this.#read();
    this.#renderMcp(f.mcp);
    this.#renderSkills(f.skills);
    this.#renderImports();
  }

  // ---------------------------------------------------------------- server updates
  /** A snapshot or building message arrived (or the projects changed). */
  refresh(): void {
    if (!this.#dlg.open || !this.#room) return;
    const floor = this.#floor, room = this.#o.rooms(floor).find((r) => r.id === this.#room!.id);
    if (!room || !!this.#state.project(floor)?.archived !== this.#readOnly || (this.#scope === 'division' && !this.#division())) { this.close(); return; }
    this.#room = room;
    if (this.#saving) return;
    if (this.#revision() !== this.#baseRevision || this.#inheritedNow() !== this.#inheritedKey) {
      if (this.#dirty()) this.#msg(CONFLICT_TEXT, true);
      else this.#load();
      return;
    }
    this.#redrawLists();
    this.#sync();
  }

  #scopeChanged(next: Scope): void {
    if (this.#blockDiscard()) { // put the switch back; the note explains
      $<HTMLInputElement>('rpScopeRoom').checked = this.#scope === 'room';
      $<HTMLInputElement>('rpScopeDivision').checked = this.#scope === 'division';
      return;
    }
    this.#scope = next;
    this.#load();
  }

  // ---------------------------------------------------------------- writes
  async #save(): Promise<void> {
    const room = this.#room;
    if (!room || this.#saving || this.#readOnly || !this.#dirty()) return;
    // The form's lists are a diff against the division it was built from: never save one against a newer division.
    if (this.#inheritedNow() !== this.#inheritedKey) { this.#msg(CONFLICT_TEXT, true); return; }
    const scope = this.#scope, floor = this.#floor, div = this.#division();
    const f = this.#read();
    const h = harnessFrom(f, this.#own(), this.#inherited());
    const path = scope === 'room'
      ? `/api/overrides/${encodeURIComponent(floor)}/${encodeURIComponent(room.id)}`
      : `/api/divisions/${encodeURIComponent(div!.id)}/harness`;
    const body = { baseRevision: this.#baseRevision, harness: scope === 'room' && Object.keys(h).length === 0 ? null : h };
    const sent = JSON.stringify(f);
    this.#saving = true;
    this.#msg('');
    this.#sync();
    let r: Response;
    let data: Record<string, unknown> | null;
    try {
      r = await post(path, body);
      data = await r.json().catch(() => null) as Record<string, unknown> | null;
    } catch {
      this.#saving = false;
      if (this.#room?.id === room.id) { this.#msg('Couldn\'t reach the office server. Your edits are still here.'); this.#sync(); }
      return;
    }
    this.#saving = false;
    if (this.#room?.id !== room.id) return; // closed meanwhile
    if (r.ok) {
      this.#absorb(scope, floor, div?.id, data);
      this.#baseRevision = typeof data?.revision === 'number' ? data.revision : this.#revision();
      this.#base = sent; // what the owner typed during the save stays unsaved
      this.#redrawLists();
      this.#msg('Saved.');
      this.#sync();
      this.refresh(); // a division change that arrived during the save
      return;
    } else if (r.status === 409) this.#msg(CONFLICT_TEXT, true);
    else if (r.status === 401 || r.status === 403) this.#msg(EXPIRED_TEXT);
    else if (r.status === 400 || r.status === 404) this.#msg(typeof data?.error === 'string' ? data.error : 'The server refused this setup.');
    else this.#msg(`Couldn't save (HTTP ${r.status}). Your edits are still here.`);
    this.#sync();
  }

  /** The broadcast may land after this response: take what was stored now if it is newer, so the next save has the right revision. */
  #absorb(scope: Scope, floor: string, division: string | undefined, data: Record<string, unknown> | null): void {
    if (!data || typeof data.revision !== 'number') return;
    const b = this.#state.building;
    if (scope === 'room') {
      if ((b.overrides[floor]?.revision ?? 0) < data.revision) b.overrides[floor] = { revision: data.revision, rooms: (data.rooms ?? {}) as Record<string, Harness> };
    } else {
      const i = b.divisions.findIndex((d) => d.id === division);
      if (i >= 0 && b.divisions[i]!.revision < data.revision) b.divisions[i] = data as unknown as DivisionDef;
    }
  }

  async #test(name: string): Promise<void> {
    if (this.#tests.get(name)?.busy) return;
    const st: TestState = { busy: true, ok: false, text: '' };
    this.#tests.set(name, st);
    this.#redrawLists();
    try {
      const r = await post(`/api/mcp/${encodeURIComponent(name)}/test`, {});
      const d = await r.json().catch(() => null) as { ok?: boolean; name?: string; error?: string } | null;
      st.busy = false;
      if (r.status === 200 && d?.ok) { st.ok = true; st.text = `Connected: ${d.name ?? ''}`; }
      else st.text = d?.error ?? (r.status === 401 || r.status === 403 ? EXPIRED_TEXT : `The test failed (HTTP ${r.status}).`);
    } catch { st.busy = false; st.text = 'Could not reach the office server.'; }
    if (this.#dlg.open) this.#redrawLists();
  }

  async #import(source: string): Promise<void> {
    const st = { busy: true, msg: '' };
    this.#imports.set(source, st);
    this.#renderImports();
    try {
      const r = await post('/api/skills/import', { source });
      if (r.ok) { this.#imports.delete(source); return; } // the building broadcast moves it to the library list
      const d = await r.json().catch(() => null) as { error?: string } | null;
      st.msg = d?.error ?? `Could not import it (HTTP ${r.status}).`;
    } catch { st.msg = 'Could not reach the office server.'; }
    st.busy = false;
    if (this.#dlg.open) this.#renderImports();
  }

  async #copy(): Promise<void> {
    const room = this.#room, note = $('rpCopyNote');
    if (!room) return;
    const text = runCommand(room.id, this.#floor), code = $('rpCmd');
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied.';
      return;
    } catch { /* no clipboard API or permission: show it and select it */ }
    code.textContent = text; code.hidden = false;
    const range = document.createRange(), sel = getSelection();
    range.selectNodeContents(code);
    sel?.removeAllRanges(); sel?.addRange(range);
    note.textContent = 'Selected: press Ctrl+C (⌘C on a Mac) to copy.';
  }

  // ---------------------------------------------------------------- Add MCP server
  #resetMcpForm(): void {
    ($('rpMcpForm') as HTMLFormElement).reset();
    $('rpMcpPairs').replaceChildren();
    this.#syncMcpType();
    this.#mcpMsg('');
  }
  #syncMcpType(): void {
    const http = $<HTMLSelectElement>('rpMcpType').value === 'http';
    $('rpMcpCmdRow').hidden = $('rpMcpArgsRow').hidden = http;
    $('rpMcpUrlRow').hidden = !http;
    $('rpMcpPairsH').textContent = http ? 'Headers' : 'Environment';
    $('rpMcpAddPair').textContent = http ? 'Add a header' : 'Add a variable';
  }
  #addPair(): void {
    const list = $('rpMcpPairs');
    const li = el('li', 'rp-pair');
    const http = $<HTMLSelectElement>('rpMcpType').value === 'http', what = http ? 'Header' : 'Variable';
    const n = list.children.length + 1;
    const k = el('input', 'rp-pk'); k.autocomplete = 'off'; k.spellcheck = false; k.placeholder = http ? 'Authorization' : 'NAME'; k.setAttribute('aria-label', `${what} ${n} name`);
    const v = el('input', 'rp-pv'); v.autocomplete = 'off'; v.spellcheck = false; v.placeholder = 'secret:<name>'; v.setAttribute('aria-label', `${what} ${n} value`);
    const x = el('button', 'btn icon', '✕'); x.type = 'button'; x.setAttribute('aria-label', `Remove ${what.toLowerCase()} ${n}`);
    x.addEventListener('click', () => { li.remove(); $('rpMcpAddPair').focus(); });
    li.append(k, v, x);
    list.append(li);
    k.focus();
  }
  #mcpMsg(text: string, ok = false): void {
    const m = $('rpMcpMsg');
    m.textContent = cleanText(text);
    m.hidden = !text;
    m.dataset.tone = ok ? 'ok' : 'err';
  }

  async #addMcp(): Promise<void> {
    const b = this.#state.building;
    const name = $<HTMLInputElement>('rpMcpName').value.trim();
    if (Object.hasOwn(b.mcp.servers, name)) { this.#mcpMsg(`There is already a server named ${name}.`); return; }
    const http = $<HTMLSelectElement>('rpMcpType').value === 'http';
    const pairs: Record<string, string> = {};
    for (const li of $('rpMcpPairs').children) {
      const k = (li.querySelector('.rp-pk') as HTMLInputElement).value.trim(), v = (li.querySelector('.rp-pv') as HTMLInputElement).value;
      if (k) pairs[k] = v;
    }
    const has = Object.keys(pairs).length > 0;
    const server: McpServerDef = http
      ? { type: 'http', url: $<HTMLInputElement>('rpMcpUrl').value.trim(), ...(has ? { headers: pairs } : {}) }
      : { command: $<HTMLInputElement>('rpMcpCommand').value.trim(), ...(lines($<HTMLTextAreaElement>('rpMcpArgs').value).length ? { args: lines($<HTMLTextAreaElement>('rpMcpArgs').value) } : {}), ...(has ? { env: pairs } : {}) };
    const go = $<HTMLButtonElement>('rpMcpSubmit');
    go.disabled = true;
    try {
      const r = await post(`/api/mcp/${encodeURIComponent(name)}`, { baseRevision: b.mcp.revision, server });
      const d = await r.json().catch(() => null) as { error?: string; revision?: number; servers?: Record<string, McpServerDef> } | null;
      if (r.ok) {
        if (d && typeof d.revision === 'number' && b.mcp.revision < d.revision && d.servers) b.mcp = { revision: d.revision, servers: d.servers };
        this.#resetMcpForm();
        this.#mcpMsg(`Added ${name}.`, true);
        this.#redrawLists();
        this.#sync();
      } else if (r.status === 409) this.#mcpMsg('The MCP list changed elsewhere. Try again.');
      else if (r.status === 401 || r.status === 403) this.#mcpMsg(EXPIRED_TEXT);
      else this.#mcpMsg(d?.error ?? `Couldn't add it (HTTP ${r.status}).`);
    } catch { this.#mcpMsg('Could not reach the office server.'); }
    finally { go.disabled = false; }
  }
}
