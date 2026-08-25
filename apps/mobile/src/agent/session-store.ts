import type { ConceptStatus, SessionRecap, StudySet } from "@viva/core";

export type MobileSessionResult = {
  conceptStatuses: Record<string, ConceptStatus>;
  recap?: SessionRecap;
  studySet: StudySet;
  studySetTitle?: string;
};

let current: MobileSessionResult | undefined;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export const sessionResultStore = {
  clear(): void {
    current = undefined;
    publish();
  },
  get(): MobileSessionResult | undefined {
    return current;
  },
  set(result: MobileSessionResult): void {
    current = result;
    publish();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
