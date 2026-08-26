import { Request, Response } from "express";
import * as bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../middleware/auth";

export async function login(req: Request, res: Response) {
  const { identifier, password } = req.body as { identifier: string; password: string };
  if (!identifier || !password) {
    return res.status(400).json({ error: "identifier and password required" });
  }

  const isEmail = identifier.includes("@");
  const profile = await prisma.profile.findFirst({
    where: isEmail ? { email: identifier } : { username: identifier },
  });
  if (!profile || !profile.password_hash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, profile.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const userRole = await prisma.userRole.findFirst({
    where: { user_id: profile.id },
  });
  if (!userRole) {
    return res.status(403).json({ error: "No role assigned" });
  }

  const payload = { userId: profile.id, schoolId: userRole.school_id, role: userRole.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  return res.json({ accessToken, refreshToken, user: { id: profile.id, fullName: profile.full_name, email: profile.email, role: userRole.role } });
}

export async function refreshToken(req: Request, res: Response) {
  const { refreshToken: token } = req.body as { refreshToken: string };
  if (!token) {
    return res.status(400).json({ error: "refreshToken required" });
  }
  try {
    const payload = verifyRefreshToken(token);
    const accessToken = signAccessToken(payload);
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
}
