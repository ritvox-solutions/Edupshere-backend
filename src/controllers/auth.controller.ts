import { Request, Response } from "express";
import crypto from "crypto";
import * as bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../middleware/auth";

// Mock MSG91/Gupshup sender – in real code call provider API
async function sendOtpViaProvider(phone: string, code: string) {
  console.log(`[OTP MOCK] Sending OTP ${code} to ${phone}`);
}

export async function requestOtp(req: Request, res: Response) {
  const { phone } = req.body as { phone: string };
  if (!phone) {
    return res.status(400).json({ error: "phone required" });
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await prisma.otpCode.create({
    data: { phone, code_hash: codeHash, expires_at: expiresAt },
  });

  await sendOtpViaProvider(phone, code);
  return res.json({ message: "OTP sent" });
}

export async function verifyOtp(req: Request, res: Response) {
  const { phone, code } = req.body as { phone: string; code: string };
  if (!phone || !code) {
    return res.status(400).json({ error: "phone and code required" });
  }
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const otp = await prisma.otpCode.findFirst({
    where: { phone, code_hash: codeHash, consumed_at: null, expires_at: { gt: new Date() } },
    orderBy: { created_at: "desc" },
  });

  if (!otp) {
    return res.status(401).json({ error: "Invalid or expired OTP" });
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });

  const profile = await prisma.profile.findUnique({ where: { phone } });
  if (!profile) {
    return res.status(404).json({ error: "Profile not found" });
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

  return res.json({ accessToken, refreshToken });
}

export async function signup(req: Request, res: Response) {
  const { fullName, usernameOrEmail, password, role } = req.body as {
    fullName: string;
    usernameOrEmail: string;
    password: string;
    role?: string;
  };
  console.log('[SIGNUP] Request body:', { fullName, usernameOrEmail, role });
  if (!fullName || !usernameOrEmail || !password) {
    console.log('[SIGNUP] Missing fields');
    return res.status(400).json({ error: "fullName, usernameOrEmail and password required" });
  }
  const email = usernameOrEmail.includes("@") ? usernameOrEmail : null;
  const username = usernameOrEmail.includes("@") ? null : usernameOrEmail;

  const existing = await prisma.profile.findFirst({
    where: { OR: [{ email: email! }, { full_name: fullName }] },
  });
  console.log('[SIGNUP] Existing user:', !!existing);
  if (existing) {
    return res.status(409).json({ error: "User already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const profile = await prisma.profile.create({
    data: {
      full_name: fullName,
      email: email ?? null,
      password_hash: passwordHash,
      preferred_language: "en",
    },
  });
  console.log('[SIGNUP] Profile created:', profile.id);

  // Optionally create a demo school and assign role if provided
  if (role) {
    const school = await prisma.school.findFirst();
    if (school) {
      await prisma.userRole.create({
        data: { user_id: profile.id, school_id: school.id, role: role as any },
      });
      console.log('[SIGNUP] Role assigned:', role);
    } else {
      console.log('[SIGNUP] No school found for role assignment');
    }
  }

  return res.status(201).json({ id: profile.id, fullName: profile.full_name, email: profile.email });
}

export async function login(req: Request, res: Response) {
  const { identifier, password } = req.body as { identifier: string; password: string };
  console.log('[LOGIN] Request identifier:', identifier);
  if (!identifier || !password) {
    console.log('[LOGIN] Missing identifier/password');
    return res.status(400).json({ error: "identifier and password required" });
  }

  const isEmail = identifier.includes("@");
  const profile = await prisma.profile.findFirst({
    where: isEmail ? { email: identifier } : { full_name: identifier },
  });
  console.log('[LOGIN] Profile found:', !!profile, profile?.id);
  if (!profile || !profile.password_hash) {
    console.log('[LOGIN] Invalid credentials - profile not found or no password');
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, profile.password_hash);
  console.log('[LOGIN] Password valid:', valid);
  if (!valid) {
    console.log('[LOGIN] Invalid password');
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const userRole = await prisma.userRole.findFirst({
    where: { user_id: profile.id },
  });
  console.log('[LOGIN] UserRole found:', !!userRole, userRole);
  if (!userRole) {
    console.log('[LOGIN] No role assigned for user', profile.id);
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
