/**
 * "Now", as the site sees it.
 *
 * Business dates are stored as `date` and read back with
 * `value.toISOString().slice(0, 10)`, which is correct: Prisma hands back a
 * `date` column as UTC midnight, so the UTC slice is the stored day.
 *
 * Deriving *today* is the opposite case. The container runs TZ=UTC (so that
 * every timestamptz is unambiguous) while the plant runs at UTC+8, and
 * `new Date().toISOString()` is therefore eight hours behind the floor. From
 * midnight to 8am Malaysian time the UTC slice still reads yesterday — and
 * this plant runs a night shift, so that window is staffed. A clerk keying at
 * 1am would have been handed yesterday's entry page, with nothing on screen
 * to say so.
 *
 * Everything that means "today" or "this month" goes through here.
 */

const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Asia/Kuala_Lumpur'

// en-CA formats as YYYY-MM-DD, which is the shape the rest of the app passes
// around. The timeZone option is what does the real work.
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today's business date at the plant, as `YYYY-MM-DD`. */
export function businessToday(now: Date = new Date()): string {
  return dayFormat.format(now)
}

/** The month in progress at the plant, as `YYYY-MM`. */
export function businessMonth(now: Date = new Date()): string {
  return businessToday(now).slice(0, 7)
}

/**
 * Month arithmetic on a `YYYY-MM` string. Pure string-to-string: the input is
 * already an explicit month, so there is no clock and no zone to get wrong.
 */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
}

// A stamp for a sheet that leaves the building. Rendered on the server, so the
// zone has to be named: the container's own clock is UTC.
const stampFormat = new Intl.DateTimeFormat('en-MY', {
  timeZone: DISPLAY_TZ,
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Format an instant in plant-local time, e.g. "14 Sep 2026, 11:38 pm". */
export function formatStamp(at: Date | string): string {
  return stampFormat.format(typeof at === 'string' ? new Date(at) : at)
}
