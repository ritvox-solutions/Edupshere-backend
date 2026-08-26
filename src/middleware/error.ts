import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ status: "error", message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      res.status(404).json({ status: "error", message: "Not found" });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ status: "error", message: "Already exists" });
      return;
    }
  }
  console.error(err);
  res.status(500).json({ status: "error", message: "Internal server error" });
}
