/**
 * Cost Explorer date-range helpers.
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 */

/**
 * Builds a date range covering the current calendar month.
 * Cost Explorer requires Start (inclusive) and End (exclusive).
 */
export function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  const start = `${year}-${String(month + 1).padStart(2, "0")}-01`;

  // End is exclusive — first day of next month
  const nextMonth = month + 1;
  const endYear = nextMonth > 11 ? year + 1 : year;
  const endMonth = nextMonth > 11 ? 1 : nextMonth + 1;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

  return { start, end };
}
