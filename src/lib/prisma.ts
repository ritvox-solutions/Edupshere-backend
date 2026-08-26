import { PrismaClient, Prisma } from "@prisma/client";
import { getScope } from "./scope";

declare global {
  var __prisma: ReturnType<typeof createClient> | undefined;
}

// Every model here has a direct school_id column. Any query against them is
// auto-scoped to the caller's school unless they're a super_admin — this is
// the single place tenant isolation is enforced, so a route handler forgetting
// to filter by school_id can no longer leak or mutate another school's rows.
const TENANT_SCOPED_MODELS = new Set([
  "UserRole",
  "Class",
  "Section",
  "Subject",
  "Student",
  "FeeStructure",
  "AttendanceRecord",
  "NotificationLog",
  "TimetableEntry",
  "Homework",
  "Exam",
  "Announcement",
]);

const WHERE_SCOPED_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

function createClient() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }
          const scope = getScope();
          if (!scope?.schoolId || scope.role === "super_admin") {
            return query(args);
          }
          const schoolId = scope.schoolId;
          const scopedArgs = args as any;

          if (operation === "create") {
            scopedArgs.data = { ...scopedArgs.data, school_id: scopedArgs.data?.school_id ?? schoolId };
          } else if (operation === "createMany") {
            const data = scopedArgs.data;
            scopedArgs.data = Array.isArray(data)
              ? data.map((row: any) => ({ ...row, school_id: row?.school_id ?? schoolId }))
              : { ...data, school_id: data?.school_id ?? schoolId };
          } else if (operation === "upsert") {
            scopedArgs.where = { ...scopedArgs.where, school_id: schoolId };
            scopedArgs.create = { ...scopedArgs.create, school_id: scopedArgs.create?.school_id ?? schoolId };
          } else if (WHERE_SCOPED_OPERATIONS.has(operation)) {
            scopedArgs.where = { ...scopedArgs.where, school_id: schoolId };
          }

          return query(scopedArgs);
        },
      },
    },
  });
}

const prismaClient = global.__prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prismaClient;
}

export { Prisma };
export const prisma = prismaClient;
export default prisma;
