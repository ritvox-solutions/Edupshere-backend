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

export function withSchoolScope(modelName: string) {
  const tenantModels = new Set(["UserRole", "School", "Profile"]);
  // Profile is not tenant scoped but we may still need it.
  // For now, apply filter to models that have school_id
  const modelsWithSchoolId = new Set(["UserRole"]);
  return (args: any) => {
    const scope = getScope();
    if (!scope?.schoolId || scope.role === "super_admin") {
      return args;
    }
    if (modelsWithSchoolId.has(modelName)) {
      const where = args.args?.where ?? {};
      args.args.where = {
        ...where,
        school_id: scope.schoolId,
      };
    }
    return args;
  };
}
