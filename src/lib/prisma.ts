// @ts-nocheck
import { PrismaClient } from "@prisma/client";
import { getScope } from "./scope";

declare global {
  var __prisma: any;
}

function createClient() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  return client.$extends({
    query: {
      userRole: {
        findMany({ args, query }) {
          const scope = getScope();
          if (scope?.schoolId && scope.role !== "super_admin") {
            args.where = { ...args.where, school_id: scope.schoolId };
          }
          return query(args);
        },
        findFirst({ args, query }) {
          const scope = getScope();
          if (scope?.schoolId && scope.role !== "super_admin") {
            args.where = { ...args.where, school_id: scope.schoolId };
          }
          return query(args);
        },
        findUnique({ args, query }) {
          const scope = getScope();
          if (scope?.schoolId && scope.role !== "super_admin") {
            args.where = { ...args.where, school_id: scope.schoolId };
          }
          return query(args);
        },
        create({ args, query }) {
          const scope = getScope();
          if (scope?.schoolId && scope.role !== "super_admin") {
            args.data = { ...args.data, school_id: args.data.school_id ?? scope.schoolId };
          }
          return query(args);
        },
        update({ args, query }) {
          const scope = getScope();
          if (scope?.schoolId && scope.role !== "super_admin") {
            if (args.where) {
              args.where = { ...args.where, school_id: scope.schoolId };
            }
          }
          return query(args);
        },
        delete({ args, query }) {
          const scope = getScope();
          if (scope?.schoolId && scope.role !== "super_admin") {
            if (args.where) {
              args.where = { ...args.where, school_id: scope.schoolId };
            }
          }
          return query(args);
        },
      },
    },
  });
}

const prismaClient = global.__prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prismaClient;
}

export const prisma = prismaClient;
export default prisma;
