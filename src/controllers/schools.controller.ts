import { Request, Response } from "express";
import * as bcrypt from "bcryptjs";
import prisma, { Prisma } from "../lib/prisma";
import { AuthPayload } from "../middleware/auth";
import { toDate } from "../lib/dates";
import { generateTempPassword } from "../lib/password";

// India's school year runs April–March; used only as a sane default when the
// super admin doesn't specify one during quick onboarding.
function defaultAcademicYear(): { start: Date; end: Date } {
  const now = new Date();
  const year = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return {
    start: new Date(Date.UTC(year, 3, 1)),
    end: new Date(Date.UTC(year + 1, 2, 31)),
  };
}

export async function getMySchool(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  const school = await prisma.school.findUnique({ where: { id: auth.schoolId } });
  if (!school) {
    return res.status(404).json({ error: "School not found" });
  }
  return res.json({ school });
}

export async function updateMySchool(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (!["school_admin", "super_admin"].includes(auth.role)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  const {
    name,
    address,
    academic_year_start,
    academic_year_end,
    language_default,
    logo_url,
    contact_email,
    contact_phone,
    principal_name,
    website,
    timezone,
    currency,
  } = req.body;
  try {
    const data: Record<string, unknown> = {
      ...(name !== undefined && { name }),
      ...(address !== undefined && { address }),
      ...(academic_year_start !== undefined && { academic_year_start: new Date(academic_year_start) }),
      ...(academic_year_end !== undefined && { academic_year_end: new Date(academic_year_end) }),
      ...(language_default !== undefined && { language_default }),
      ...(logo_url !== undefined && { logo_url }),
      ...(contact_email !== undefined && { contact_email }),
      ...(contact_phone !== undefined && { contact_phone }),
      ...(principal_name !== undefined && { principal_name }),
      ...(website !== undefined && { website }),
      ...(timezone !== undefined && { timezone }),
      ...(currency !== undefined && { currency }),
    };
    const school = await prisma.school.update({
      where: { id: auth.schoolId },
      data: data as Prisma.SchoolUpdateInput,
    });
    return res.json({ school });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}

export async function listSchools(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (auth.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin only" });
  }
  const schools = await prisma.school.findMany({
    // Excludes the internal placeholder school used only to anchor super_admin
    // UserRole rows (see prisma/seed.ts) — it's never a real tenant.
    where: { name: { not: "__platform__" } },
    orderBy: { created_at: "desc" },
    include: {
      userRoles: {
        where: { role: "school_admin" },
        include: { user: { select: { id: true, full_name: true, email: true } } },
      },
      _count: { select: { students: true } },
    },
  });
  return res.json({
    schools: schools.map((s) => ({
      id: s.id,
      name: s.name,
      address: s.address,
      subscription_status: s.subscription_status,
      language_default: s.language_default,
      created_at: s.created_at,
      studentCount: s._count.students,
      admins: s.userRoles.map((r) => r.user),
    })),
  });
}

export async function getSchool(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (auth.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin only" });
  }
  const { id } = req.params;
  const school = await prisma.school.findUnique({
    where: { id },
    include: {
      userRoles: {
        where: { role: "school_admin" },
        include: { user: { select: { id: true, full_name: true, email: true, created_at: true } } },
      },
      _count: { select: { students: true } },
    },
  });
  if (!school) return res.status(404).json({ error: "School not found" });
  return res.json({
    school: {
      ...school,
      studentCount: school._count.students,
      admins: school.userRoles.map((r) => r.user),
      userRoles: undefined,
      _count: undefined,
    },
  });
}

export async function createSchool(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (auth.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin only" });
  }
  const { academic_year_start, academic_year_end, admin, ...schoolData } = req.body;
  if (!schoolData.name || !schoolData.address) {
    return res.status(400).json({ error: "name and address required" });
  }
  if (!admin?.full_name || !admin?.email) {
    return res.status(400).json({ error: "admin.full_name and admin.email required to create the school's login" });
  }

  const existingAdmin = await prisma.profile.findFirst({ where: { email: admin.email } });
  if (existingAdmin) {
    return res.status(409).json({ error: "A user with this admin email already exists" });
  }

  const fallbackYear = defaultAcademicYear();
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  try {
    const { school, adminProfile } = await prisma.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          ...schoolData,
          academic_year_start: toDate(academic_year_start) ?? fallbackYear.start,
          academic_year_end: toDate(academic_year_end) ?? fallbackYear.end,
          language_default: schoolData.language_default ?? "en",
          subscription_status: schoolData.subscription_status ?? "trial",
        },
      });
      const adminProfile = await tx.profile.create({
        data: {
          full_name: admin.full_name,
          email: admin.email,
          password_hash: passwordHash,
          preferred_language: "en",
        },
      });
      await tx.userRole.create({
        data: { user_id: adminProfile.id, school_id: school.id, role: "school_admin" },
      });
      // Every school teaches Class 1-10 by default — the admin deletes whichever
      // don't apply rather than having to add ten rows by hand on day one.
      await tx.class.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          school_id: school.id,
          name: `Class ${i + 1}`,
          display_order: i,
        })),
      });
      return { school, adminProfile };
    });

    return res.status(201).json({
      school,
      admin: { id: adminProfile.id, fullName: adminProfile.full_name, email: adminProfile.email, tempPassword },
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}

export async function addSchoolAdmin(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (auth.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin only" });
  }
  const { id: schoolId } = req.params;
  const { full_name, email } = req.body;
  if (!full_name || !email) {
    return res.status(400).json({ error: "full_name and email required" });
  }
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school) return res.status(404).json({ error: "School not found" });

  const existing = await prisma.profile.findFirst({ where: { email } });
  if (existing) return res.status(409).json({ error: "A user with this email already exists" });

  const tempPassword = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, 10);
  const profile = await prisma.profile.create({
    data: { full_name, email, password_hash, preferred_language: "en" },
  });
  await prisma.userRole.create({ data: { user_id: profile.id, school_id: schoolId, role: "school_admin" } });

  return res.status(201).json({ admin: { id: profile.id, fullName: profile.full_name, email, tempPassword } });
}

export async function resetAdminPassword(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (auth.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin only" });
  }
  const { id: schoolId, profileId } = req.params;
  const role = await prisma.userRole.findFirst({
    where: { user_id: profileId, school_id: schoolId, role: "school_admin" },
  });
  if (!role) return res.status(404).json({ error: "Admin not found for this school" });

  const tempPassword = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, 10);
  await prisma.profile.update({ where: { id: profileId }, data: { password_hash } });

  return res.json({ tempPassword });
}
