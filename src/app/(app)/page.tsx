import { businessToday } from '@/lib/clock'
import { loadDashboard } from '@/lib/dashboard'
import { LineChart, Bars, Legend } from '@/components/charts'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

const money = (v: number) =>
  v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kg = (v: number) => v.toLocaleString('en-MY', { maximumFractionDigits: 0 })
const perKg = (v: number) => v.toFixed(4)
const sen = (v: number) => `${(v * 100).toFixed(2)} sen`

function StatusBadge({ status }: { status: 'PROVISIONAL' | 'FINAL' | 'NO_RATE' }) {
  const label =
    status === 'FINAL' ? 'Final' : status === 'PROVISIONAL' ? 'Provisional' : 'Not costed'
  return <span className={`badge ${status.toLowerCase()}`}>{label}</span>
}

export default async function Dashboard() {
  await requireUser()
  const today = businessToday()
  const { kpi, months, series, alerts } = await loadDashboard(today)

  const monthLabels = months.map((m) => m.month)
  const costSeries = [
    { key: 'TUBE', label: 'Cost of ice', points: months.map((m) => ({ month: m.month, value: m.rmPerKg })) },
  ]
  // A stopped line belongs in the record, not on the same axis as the running
  // ones: the small pool ran near 0.44 kWh/kg against about 0.11 for everything
  // else, so plotting them together compresses the lines that still matter into
  // an unreadable band. It keeps its row in the table and a note below.
  const active = series.filter((s) => !s.retired)
  const retired = series.filter((s) => s.retired)
  const intensitySeries = active.map((s) => ({
    key: s.line,
    label: s.label,
    points: s.points.map((p) => ({ month: p.month, value: p.kwhPerKg })),
  }))

  return (
    <main className="viz-root">
      <h1>Dashboard</h1>
      <p className="sub">
        Month to date, {kpi.month} · {kpi.daysWithData} day{kpi.daysWithData === 1 ? '' : 's'} with data
      </p>

      <section className="kpis" aria-label="Month to date">
        <div className="kpi">
          <span className="kpi-label">Ice produced</span>
          <span className="kpi-value">{kg(kpi.kg)}<small>kg</small></span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Sales</span>
          <span className="kpi-value"><small>RM</small>{money(kpi.salesRm)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Electricity <StatusBadge status={kpi.status} /></span>
          <span className="kpi-value"><small>RM</small>{money(kpi.electricityRm)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Cost per kg</span>
          <span className="kpi-value">
            {kpi.costPerKg === null ? '—' : <><small>RM</small>{perKg(kpi.costPerKg)}</>}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Sales per kg</span>
          <span className="kpi-value">
            {kpi.salesPerKg === null ? '—' : <><small>RM</small>{perKg(kpi.salesPerKg)}</>}
          </span>
        </div>
      </section>

      {/*
        The four the owner's cost template leads on. They are the site figures
        rather than the ice ones: what a kWh actually cost this month, how much
        of the bill still has no owner, what the giveaway has come to this year,
        and whether reselling power to tenants is still worth doing.

        Each shows an em dash rather than a zero when it cannot be computed. A
        blended tariff of zero would read as free electricity and a coldroom
        margin of zero as breaking even, and both would be wrong in the
        direction that gets missed.
      */}
      <section className="kpis secondary" aria-label="Site, month to date">
        <div className="kpi">
          <span className="kpi-label">Blended tariff</span>
          <span className="kpi-value">
            {kpi.blendedRate === null ? '—' : <><small>RM</small>{perKg(kpi.blendedRate)}</>}
            <small>/kWh</small>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Unaccounted</span>
          <span className="kpi-value">
            {kpi.unallocatedRm === null ? '—' : <><small>RM</small>{money(kpi.unallocatedRm)}</>}
            {kpi.unallocatedShare === null ? null : (
              <small>{(kpi.unallocatedShare * 100).toFixed(1)}% of bill</small>
            )}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Coldroom margin</span>
          <span className="kpi-value">
            {kpi.coldroomMarginRm === null ? '—' : <><small>RM</small>{money(kpi.coldroomMarginRm)}</>}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">FOC year to date</span>
          <span className="kpi-value">
            {kg(Math.round(kpi.focTonnesYtd))}<small>tonnes</small>
          </span>
        </div>
      </section>

      {alerts.length ? (
        <section className="alerts" aria-label="Alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${a.level.toLowerCase()}`}>
              <strong>{a.title}</strong>
              <span>{a.detail}</span>
            </div>
          ))}
        </section>
      ) : null}

      {/*
        Two panels sharing an x-axis rather than one chart with two y-scales.
        A dual axis lets the reader infer a relationship from whatever the
        scaling happens to produce; stacking them keeps the comparison honest.
      */}
      <section className="panel">
        <h2>Cost of ice, and the tariff behind it</h2>
        <p className="axis-unit">Ringgit per kilogram</p>
        <p className="note">
          Flat kWh per kg with rising RM per kg means tariff, not plant. AFA is the
          only part of this tariff that moves.
        </p>
        <LineChart
          series={costSeries}
          months={monthLabels}
          format={(v) => `RM${v.toFixed(4)}`}
          formatTick={(v) => v.toFixed(4)}
          ariaLabel="Cost of ice in ringgit per kilogram, by month"
        />
        <h3>AFA billed, sen per kWh</h3>
        <Bars
          points={months.map((m) => ({ month: m.month, value: m.afa }))}
          format={sen}
          ariaLabel="Automatic fuel adjustment, sen per kilowatt hour, by month"
          diverging
        />
      </section>

      <section className="panel">
        <h2>Energy intensity by line</h2>
        <p className="note">
          kWh per kg. The plant efficiency signal — it moves only when the machines do.
        </p>
        <Legend items={active.map((s) => ({ key: s.line, label: s.label }))} />
        <LineChart
          series={intensitySeries}
          months={monthLabels}
          format={(v) => v.toFixed(3)}
          ariaLabel="Kilowatt hours per kilogram by production line, by month"
        />
        {retired.map((s) => (
          <p className="note retired" key={s.line}>
            <strong>{s.label}</strong> stopped on {s.retiredOn} and is not plotted
            above: it ran at{' '}
            <strong>{s.meanKwhPerKg?.toFixed(3)} kWh/kg</strong>, roughly four times
            the lines still running, which is visible here for the first time. Its
            months remain in the table.
          </p>
        ))}
      </section>

      {/*
        The table is not a fallback. Two of the light-mode series hues sit below
        3:1 against the surface, so a non-colour reading of the same numbers has
        to be present.
      */}
      <section className="panel">
        <h2>The same figures, as a table</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Ice kg</th>
                <th className="num">kWh</th>
                <th className="num">kWh/kg</th>
                <th className="num">Electricity RM</th>
                <th className="num">RM/kg</th>
                <th className="num">AFA</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td className="num">{kg(m.iceKg)}</td>
                  <td className="num">{kg(m.iceKwh)}</td>
                  <td className="num">{m.kwhPerKg === null ? '—' : m.kwhPerKg.toFixed(4)}</td>
                  <td className="num">{m.status === 'NO_RATE' ? '—' : money(m.costRm)}</td>
                  <td className="num">{m.rmPerKg === null ? '—' : m.rmPerKg.toFixed(4)}</td>
                  <td className="num">{m.afa === null ? '—' : sen(m.afa)}</td>
                  <td><StatusBadge status={m.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
