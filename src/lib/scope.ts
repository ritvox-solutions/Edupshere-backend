import { AsyncLocalStorage } from "async_hooks";

export interface Scope {
  schoolId: string | null;
  role: string | null;
  userId: string | null;
}

const storage = new AsyncLocalStorage<Scope>();

export function runWithScope<T>(scope: Scope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function getScope(): Scope | undefined {
  return storage.getStore();
}
