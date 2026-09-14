/**
 * Server-rendered SVG charts. No chart library: these are small, the data is
 * already on the server, and a dependency here would buy nothing.
 *
 * Colour follows the validated categorical order — blue, orange, aqua, yellow —
 * assigned per line and never cycled, so a line keeps its colour when another
 * is filtered out. Two of the light-mode hues sit under 3:1 on the surface, so
 * every series is direct-labelled and a table view accompanies each chart.
 */

export const SERIES_ORDER = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL'] as const

export const seriesVar = (line: string): string => {
  const i = SERIES_ORDER.indexOf(line as (typeof SERIES_ORDER)[number])
  return `var(--series-${i < 0 ? 1 : i + 1})`
}

interface Point {
  month: string
  value: number | null
}

interface LineChartProps {
  series: { key: string; label: string; points: Point[] }[]
  months: string[]
  /** Formats a value in a tooltip, where there is room for units. */
  format: (v: number) => string
  /** Formats an axis tick. Keep it short — it has to fit the left gutter, which
   *  is fixed in user space and gets no wider when the SVG scales down. */
  formatTick?: (v: number) => string
  height?: number
  /** Forces the y-axis to start at zero. Off by default: these are ratios. */
  zeroBased?: boolean
  ariaLabel: string
}

// The left gutter is fixed in user space and must hold the widest tick label
// at the largest font the chart ever uses — which is the phone size, where the
// labels are scaled up to stay legible.
const PAD = { top: 14, right: 74, bottom: 26, left: 60 }

export function LineChart({
  series, months, format, formatTick, height = 210, zeroBased = false, ariaLabel,
}: LineChartProps) {
  const tick = formatTick ?? format
  const width = 640
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v): v is number => v !== null)
  if (!values.length || months.length < 2) {
    return <p className="empty">Not enough data yet.</p>
  }

  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const lo = zeroBased ? 0 : rawMin - (rawMax - rawMin || rawMax) * 0.15
  const hi = rawMax + (rawMax - rawMin || rawMax) * 0.15

  const x = (i: number) =>
    PAD.left + (i / (months.length - 1)) * (width - PAD.left - PAD.right)
  const y = (v: number) =>
    PAD.top + (1 - (v - lo) / (hi - lo || 1)) * (height - PAD.top - PAD.bottom)

  const ticks = [lo, lo + (hi - lo) / 2, hi]

  // Direct labels are mandatory here, so they must not land on top of each
  // other: lines that finish close together (big pool and BIMC sit within
  // half a hundredth of each other) would otherwise overprint. Lay them out
  // in value order and push each down to clear the one above.
  const LABEL_GAP = 13
  const drawn = series
    .map((s) => {
      const pts = s.points
        .map((p, i) => ({ i, v: p.value }))
        .filter((p): p is { i: number; v: number } => p.v !== null)
      if (!pts.length) return null
      const lastI = pts[pts.length - 1].i
      return {
        s,
        pts,
        dPath: pts.map((p, n) => `${n === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join(' '),
        lastI,
        idealY: y(pts[pts.length - 1].v) + 4,
        labelY: 0,
      }
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.idealY - b.idealY)

  let floor = -Infinity
  for (const item of drawn) {
    item.labelY = Math.max(item.idealY, floor + LABEL_GAP)
    floor = item.labelY
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="chart"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Recessive grid: it orients, it does not compete with the marks. */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.left - 8} y={y(t) + 4} className="axis" textAnchor="end">
            {tick(t)}
          </text>
        </g>
      ))}

      {months.map((m, i) =>
        i === 0 || i === months.length - 1 || months.length <= 8 || i % 2 === 0 ? (
          <text key={m} x={x(i)} y={height - 8} className="axis" textAnchor="middle">
            {m.slice(2)}
          </text>
        ) : null
      )}

      {drawn.map(({ s, pts, dPath, labelY, lastI }) => (
        <g key={s.key} style={{ color: seriesVar(s.key) }}>
          <path d={dPath} className="line" />
          {pts.map((p) => (
            <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={4} className="dot">
              <title>{`${s.label} — ${months[p.i]}: ${format(p.v)}`}</title>
            </circle>
          ))}
          {/* Direct label: identity is never colour alone. A leader line keeps
              the label tied to its series once de-collision has moved it. */}
          <line
            x1={x(lastI) + 4}
            y1={y(pts[pts.length - 1].v)}
            x2={x(lastI) + 9}
            y2={labelY - 4}
            className="leader"
          />
          <text x={x(lastI) + 11} y={labelY} className="direct-label">
            {s.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

interface BarsProps {
  points: Point[]
  format: (v: number) => string
  height?: number
  ariaLabel: string
  /** Values can be negative — AFA was a rebate for the first four months. */
  diverging?: boolean
}

export function Bars({ points, format, height = 120, ariaLabel, diverging }: BarsProps) {
  const width = 640
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (!values.length) return <p className="empty">Not enough data yet.</p>

  const hi = Math.max(...values, 0)
  const lo = Math.min(...values, 0)
  const span = hi - lo || 1
  const y = (v: number) => PAD.top + (1 - (v - lo) / span) * (height - PAD.top - PAD.bottom)
  const zero = y(0)
  const slot = (width - PAD.left - PAD.right) / points.length
  const barW = Math.min(slot - 6, 34)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="chart"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      <line x1={PAD.left} x2={width - PAD.right} y1={zero} y2={zero} className="grid strong" />
      <text x={PAD.left - 8} y={zero + 4} className="axis" textAnchor="end">0</text>

      {points.map((p, i) => {
        if (p.value === null) return null
        const cx = PAD.left + slot * i + slot / 2
        const top = p.value >= 0 ? y(p.value) : zero
        const h = Math.max(Math.abs(y(p.value) - zero), 1)
        return (
          <g key={p.month}>
            <rect
              x={cx - barW / 2}
              y={top}
              width={barW}
              height={h}
              rx={3}
              className={diverging && p.value < 0 ? 'bar rebate' : 'bar surcharge'}
            >
              <title>{`${p.month}: ${format(p.value)}`}</title>
            </rect>
            <text x={cx} y={height - 8} className="axis" textAnchor="middle">
              {p.month.slice(2)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function Legend({ items }: { items: { key: string; label: string }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.key}>
          <span className="swatch" style={{ background: seriesVar(i.key) }} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  )
}
