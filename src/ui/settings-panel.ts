// Settings: a small dialog opened from the header on every floor. One field for now; each new setting is one more field in
// the form, saved through the same revision-checked POST /api/settings.
import { PERMISSION_MODES, type PermissionMode } from '../shared/harness.ts';
import { post } from './panel.ts';
import { PERMISSION_LABELS } from './room-panel.ts';
import { cleanText, type OfficeState } from './state.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class SettingsUi {
  #state: OfficeState;
  #dlg = $<HTMLDialogElement>('settingsDlg');
  #mode = $<HTMLSelectElement>('settingsMode');
  #save = $<HTMLButtonElement>('settingsSave');
  #opener: HTMLElement | null = null;
  #base = 0;
  #loaded: PermissionMode = 'auto';
  #saving = false;

  constructor(state: OfficeState) {
    this.#state = state;
    this.#mode.replaceChildren(...PERMISSION_MODES.map((m) => { const o = document.createElement('option'); o.value = m; o.textContent = PERMISSION_LABELS[m]; return o; }));
    $('settingsBtn').addEventListener('click', (e) => this.open(e.currentTarget as HTMLElement));
    $('settingsClose').addEventListener('click', () => this.close());
    $('settingsCancel').addEventListener('click', () => this.close());
    $('settingsReload').addEventListener('click', () => { this.#load(); this.#save.focus(); });
    $('settingsForm').addEventListener('submit', (e) => { e.preventDefault(); void this.#submit(); });
    this.#mode.addEventListener('change', () => this.#sync());
    this.#dlg.addEventListener('close', () => { if (this.#dlg.open) return; const o = this.#opener; this.#opener = null; o?.focus?.(); });
  }

  get isOpen(): boolean { return this.#dlg.open; }

  open(opener: HTMLElement | null): void {
    if (this.#dlg.open) return;
    this.#opener = opener;
    this.#load();
    this.#dlg.showModal();
    this.#mode.focus();
  }

  close(): void { if (this.#dlg.open) this.#dlg.close(); }

  /** A building message: follow the server unless the owner has a change in progress. */
  refresh(): void {
    if (!this.#dlg.open || this.#saving) return;
    const s = this.#state.building.settings;
    if (s.revision === this.#base) return;
    if (this.#mode.value === this.#loaded) this.#load(); // nothing changed here: just follow
    else this.#msg('These settings changed elsewhere. Reload to see the latest.', true);
  }

  #load(): void {
    const s = this.#state.building.settings;
    this.#base = s.revision;
    this.#loaded = s.default_permission_mode;
    this.#mode.value = s.default_permission_mode;
    this.#msg('');
    this.#sync();
  }

  #sync(): void {
    this.#save.disabled = this.#saving || this.#mode.value === this.#loaded;
    this.#save.textContent = this.#saving ? 'Saving…' : 'Save';
  }

  #msg(text: string, conflict = false): void {
    const box = $('settingsMsgBox');
    $('settingsMsg').textContent = cleanText(text);
    box.hidden = !text;
    $('settingsReload').hidden = !conflict;
  }

  async #submit(): Promise<void> {
    if (this.#saving || this.#mode.value === this.#loaded) return;
    const mode = this.#mode.value as PermissionMode;
    this.#saving = true;
    this.#msg('');
    this.#sync();
    try {
      const r = await post('/api/settings', { baseRevision: this.#base, default_permission_mode: mode });
      const d = await r.json().catch(() => null) as { error?: string; revision?: number; default_permission_mode?: PermissionMode } | null;
      if (r.ok) {
        if (d && typeof d.revision === 'number' && this.#state.building.settings.revision < d.revision) this.#state.building.settings = { revision: d.revision, default_permission_mode: mode };
        this.#saving = false;
        this.close();
        return;
      }
      if (r.status === 409) this.#msg('These settings changed elsewhere. Reload to see the latest.', true);
      else if (r.status === 401 || r.status === 403) this.#msg('Your office login expired. Restart the server for a new login link.');
      else this.#msg(d?.error ?? `Couldn't save (HTTP ${r.status}).`);
    } catch { this.#msg('Couldn\'t reach the office server.'); }
    this.#saving = false;
    this.#sync();
  }
}
