// Launches the office opened that no session has claimed yet. A launch is claimed by any hook event carrying its id
// (KUBICLE_LAUNCH -> X-Kubicle-Launch). One still unclaimed after CHECK_IN_MS is reported once, then forgotten.
export const CHECK_IN_MS = 60_000;

export class LaunchWatch {
  #pending = new Map<string, { at: number; room: string }>();
  #o: { onActive?(): void; onIdle?(): void };

  /** `onActive`: the first launch is pending (start checking). `onIdle`: none is pending any more (stop: no idle work). */
  constructor(o: { onActive?(): void; onIdle?(): void } = {}) { this.#o = o; }

  add(id: string, roomName: string, now: number): void {
    const was = this.#pending.size;
    this.#pending.set(id, { at: now, room: roomName });
    if (was === 0) this.#o.onActive?.();
  }

  /** Forget a launch: its session checked in, or it never opened. */
  claim(id: string): void { if (this.#pending.delete(id) && this.#pending.size === 0) this.#o.onIdle?.(); }

  /** Room names of launches unclaimed for CHECK_IN_MS or longer at `now`; each is returned once. */
  overdue(now: number): string[] {
    const out: string[] = [];
    for (const [id, p] of this.#pending) {
      if (now - p.at >= CHECK_IN_MS) { out.push(p.room); this.#pending.delete(id); }
    }
    if (out.length > 0 && this.#pending.size === 0) this.#o.onIdle?.();
    return out;
  }

  get size(): number { return this.#pending.size; }
}

export const checkInMessage = (room: string): string => `The agent started in ${room} did not check in. Check the terminal window.`;
