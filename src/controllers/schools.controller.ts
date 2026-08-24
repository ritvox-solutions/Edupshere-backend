import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { AuthPayload } from "../middleware/auth";
import { toDate } from "../lib/dates";

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
  const { name, address, academic_year_start, academic_year_end, language_default, logo_url } = req.body;
  try {
    const school = await prisma.school.update({
      where: { id: auth.schoolId },
      data: {
        ...(name !== undefined && { name }),
        ...(address !== undefined && { address }),
        ...(academic_year_start !== undefined && { academic_year_start: new Date(academic_year_start) }),
        ...(academic_year_end !== undefined && { academic_year_end: new Date(academic_year_end) }),
        ...(language_default !== undefined && { language_default }),
        ...(logo_url !== undefined && { logo_url }),
      },
    });
    return res.json({ school });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}

export async function createSchool(req: Request, res: Response) {
  const auth = (req as any).auth as AuthPayload;
  if (auth.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin only" });
  }
  const { adminProfileId, academic_year_start, academic_year_end, ...schoolData } = req.body;
  try {
    const school = await prisma.school.create({
      data: {
        ...schoolData,
        academic_year_start: toDate(academic_year_start),
        academic_year_end: toDate(academic_year_end),
      },
    });
    if (adminProfileId) {
      await prisma.userRole.create({
        data: {
          user_id: adminProfileId,
          school_id: school.id,
          role: "school_admin",
        },
      });
    }
    return res.status(201).json({ school });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}
