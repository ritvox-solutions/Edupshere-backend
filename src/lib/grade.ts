// Best-effort mapping of a school's free-text class name to a canonical grade
// level (1–12), used to line a class up with the board syllabus. Returns null
// for anything not confidently a numbered grade (LKG, Nursery, "Section A", …)
// so those stay unset rather than guessed wrong.

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6,
  vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

export function parseGradeLevel(name: string | null | undefined): number | null {
  if (!name) return null;
  const s = name.trim().toLowerCase();

  // "grade 5", "class 8", "std 10", "standard 3"
  const worded = s.match(/(?:grade|class|std|standard)\s*[-.]?\s*(\d{1,2}|[ivx]{1,4})\b/);
  // bare "8", "8th", "10 a" (take the leading number)
  const bare = s.match(/^\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
  // "class viii", standalone roman
  const roman = s.match(/(?:grade|class|std|standard)\s*[-.]?\s*([ivx]{1,4})\b/) || s.match(/^\s*([ivx]{1,4})\b/);

  let n: number | null = null;
  if (worded) {
    n = /^\d/.test(worded[1]) ? Number(worded[1]) : (ROMAN[worded[1]] ?? null);
  } else if (bare) {
    n = Number(bare[1]);
  } else if (roman) {
    n = ROMAN[roman[1]] ?? null;
  }

  return n != null && n >= 1 && n <= 12 ? n : null;
}
