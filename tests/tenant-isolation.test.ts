// @ts-nocheck
import prisma from "../src/lib/prisma";
import { runWithScope } from "../src/lib/scope";
import { signAccessToken } from "../src/middleware/auth";

async function cleanup() {
  await prisma.userRole.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.school.deleteMany({});
}

async function seed() {
  await cleanup();
  const schoolA = await prisma.school.create({
    data: {
      id: "a1",
      name: "School A",
      address: "Addr A",
      academic_year_start: new Date("2024-04-01"),
      academic_year_end: new Date("2025-03-31"),
      language_default: "en",
      subscription_status: "active",
    },
  });
  const schoolB = await prisma.school.create({
    data: {
      id: "b1",
      name: "School B",
      address: "Addr B",
      academic_year_start: new Date("2024-04-01"),
      academic_year_end: new Date("2025-03-31"),
      language_default: "en",
      subscription_status: "active",
    },
  });

  const profileA = await prisma.profile.create({
    data: { id: "u1", full_name: "Alice", phone: "1111111111" },
  });
  const profileB = await prisma.profile.create({
    data: { id: "u2", full_name: "Bob", phone: "2222222222" },
  });

  await prisma.userRole.create({
    data: { id: "r1", user_id: profileA.id, school_id: schoolA.id, role: "school_admin" },
  });
  await prisma.userRole.create({
    data: { id: "r2", user_id: profileB.id, school_id: schoolB.id, role: "school_admin" },
  });

  return { schoolA, schoolB, profileA, profileB };
}

async function test() {
  const { schoolA, schoolB, profileA } = await seed();

  const token = signAccessToken({
    userId: profileA.id,
    schoolId: schoolA.id,
    role: "school_admin",
  });

  // Simulate request with scope from JWT
  const results = await runWithScope(
    { schoolId: schoolA.id, role: "school_admin", userId: profileA.id },
    async () => {
      const roles = await prisma.userRole.findMany();
      // Should only see roles for school A
      return roles;
    }
  );

  console.log("Roles visible to School A user:", results.map(r => r.school_id));
  const seesB = results.some(r => r.school_id === schoolB.id);
  if (seesB) {
    console.error("FAIL: School A user can see School B data");
    process.exit(1);
  } else {
    console.log("PASS: Tenant isolation enforced – School A user cannot see School B");
  }

  // Verify create is scoped
  await runWithScope(
    { schoolId: schoolA.id, role: "school_admin", userId: profileA.id },
    async () => {
      // Create a user role without explicit school_id – middleware should inject schoolA.id
      await prisma.userRole.create({
        data: {
          user_id: profileA.id,
          role: "teacher",
          // school_id omitted intentionally
        },
      } as any);
    }
  );

  const created = await prisma.userRole.findFirst({
    where: { user_id: profileA.id, role: "teacher" },
  });
  if (created?.school_id !== schoolA.id) {
    console.error("FAIL: Create did not enforce school scope");
    process.exit(1);
  }
  console.log("PASS: Create enforced school scope");

  await cleanup();
  console.log("All tenant isolation tests passed");
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
