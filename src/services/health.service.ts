import prisma from "../lib/prisma";

export const healthService = {
  async check(): Promise<{ status: string; service: string; database: string; timestamp: string }> {
    let database = "ok";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      console.error("Database health check failed:", err);
      database = "unreachable";
    }

    return {
      status: "ok",
      service: "ritvox-backend",
      database,
      timestamp: new Date().toISOString(),
    };
  },
};
