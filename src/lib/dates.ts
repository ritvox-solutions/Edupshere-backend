/** Converts a "YYYY-MM-DD" string (or any date-ish input) from a form/JSON body into a Date Prisma can accept. */
export function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}
