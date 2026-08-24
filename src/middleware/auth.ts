import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { runWithScope } from "../lib/scope";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret";
const REFRESH_SECRET = process.env.REFRESH_SECRET ?? "dev_refresh";

export interface AuthPayload {
  userId: string;
  schoolId: string;
  role: string;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    runWithScope(
      { schoolId: payload.schoolId, role: payload.role, userId: payload.userId },
      () => {
        (req as any).auth = payload;
        next();
      }
    );
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function signAccessToken(payload: AuthPayload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "10d" });
}

export function signRefreshToken(payload: AuthPayload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: "30d" });
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, REFRESH_SECRET) as AuthPayload;
}
