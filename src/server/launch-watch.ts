// Launches the office opened that no session has claimed yet. A launch is claimed by any hook event carrying its id
// (KUBICLE_LAUNCH -> X-Kubicle-Launch). One still unclaimed after CHECK_IN_MS is reported once, then forgotten.
export const CHECK_IN_MS = 60_000;

export class LaunchWatch {
  #pending = new Map<string, { at: number; room: string }>();

  add(id: string, roomName: string, now: number): void { this.#pending.set(id, { at: now, room: roomName }); }

  claim(id: string): void { this.#pending.delete(id); }

  /** Room names of launches unclaimed for CHECK_IN_MS or longer at `now`; each is returned once. */
  overdue(now: number): string[] {
    const out: string[] = [];
    for (const [id, p] of this.#pending) {
      if (now - p.at >= CHECK_IN_MS) { out.push(p.room); this.#pending.delete(id); }
    }
    return out;
  }

  get size(): number { return this.#pending.size; }
}

export const checkInMessage = (room: string): string => `The agent started in ${room} did not check in. Check the terminal window.`;
