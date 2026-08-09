/**
 * Display formatting helpers shared by the admin list pages. Kept separate
 * from schemas.ts (validation) and middleware.ts (auth) — this file has no
 * server-only concerns and is imported directly by route components.
 */

/**
 * Formats a Postgres `timestamptz` string (e.g. a row's `updated_at`, as
 * returned verbatim by the repos in src/server/repos/**) into the
 * Taiwan-conventional "YYYY/MM/DD HH:mm" string used in admin table columns.
 *
 * A timestamp that falls on the current calendar day (local time) collapses
 * to "今天 HH:mm" instead — the common case right after an edit — so it reads
 * faster than the full date. Everything else always shows the full date.
 */
export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return `今天 ${time}`;

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`;
}
