import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { generateTempPassword } from "../src/lib/password";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL ?? "superadmin@edusphere.dev";
  const existing = await prisma.profile.findFirst({
    where: { userRoles: { some: { role: "super_admin" } } },
  });
  if (existing) {
    console.log(`Super admin already exists (${existing.email}). Skipping seed.`);
    return;
  }

  const password = process.env.SUPER_ADMIN_PASSWORD ?? generateTempPassword();
  const password_hash = await bcrypt.hash(password, 10);

  // super_admin has no school — schools are what they onboard — so this
  // profile is created without a school-scoped UserRole.school_id filter.
  const profile = await prisma.profile.create({
    data: { full_name: "Super Admin", email, password_hash, preferred_language: "en" },
  });
  await prisma.userRole.create({
    data: { user_id: profile.id, school_id: (await ensureBootstrapSchool()).id, role: "super_admin" },
  });

  console.log("Created super admin:");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    console.log("  (SUPER_ADMIN_PASSWORD was not set — save this password now, it will not be shown again)");
  }
}

// UserRole.school_id is NOT NULL — super_admin's grant still needs a row to
// point at. This placeholder school is never shown or used as a tenant; it
// only exists so the schema's foreign key is satisfied.
async function ensureBootstrapSchool() {
  const existing = await prisma.school.findFirst({ where: { name: "__platform__" } });
  if (existing) return existing;
  const now = new Date();
  return prisma.school.create({
    data: {
      name: "__platform__",
      address: "N/A",
      academic_year_start: now,
      academic_year_end: now,
      language_default: "en",
      subscription_status: "internal",
    },
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
