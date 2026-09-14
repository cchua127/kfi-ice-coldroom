import { PrismaClient } from '@prisma/client'
import { siteRate } from '@/lib/tariff'

const prisma = new PrismaClient()

export const dynamic = 'force-dynamic'

/**
 * Placeholder landing page. It exists so the scaffold builds and so the
 * electricity engine can be seen working against seeded data; the staff entry
 * screen and the management dashboard replace it.
 */
export default async function Page() {
  const bills = await prisma.tnbBill.findMany({
    orderBy: [{ periodStart: 'asc' }, { accountId: 'asc' }],
    include: { account: true },
  })

  const byPeriod = new Map<string, typeof bills>()
  for (const b of bills) {
    const key = b.periodStart.toISOString().slice(0, 7)
    byPeriod.set(key, [...(byPeriod.get(key) ?? []), b])
  }

  return (
    <main>
      <h1>KFI Ice Ops</h1>
      <p className="sub">
        Foundation build — schema, tariff engine and cost engine. Entry screens and
        dashboard to follow.
      </p>

      <h2>Site electricity rate, from confirmed bills</h2>
      <table>
        <thead>
          <tr>
            <th>Period</th>
            <th className="num">Site kWh</th>
            <th className="num">Site RM</th>
            <th className="num">RM/kWh</th>
            <th className="num">vs frozen 0.484</th>
          </tr>
        </thead>
        <tbody>
          {[...byPeriod.entries()].map(([period, group]) => {
            const rate = siteRate(
              group.map((b) => ({ kwh: b.kwh.toString(), currentChargesRm: (b.currentChargesRm ?? 0).toString() }))
            )
            const kwh = group.reduce((a, b) => a + Number(b.kwh), 0)
            const rm = group.reduce((a, b) => a + Number(b.currentChargesRm ?? 0), 0)
            const delta = ((rate.toNumber() / 0.484 - 1) * 100).toFixed(1)
            return (
              <tr key={period}>
                <td>{period}</td>
                <td className="num">{kwh.toLocaleString('en-MY')}</td>
                <td className="num">{rm.toLocaleString('en-MY', { minimumFractionDigits: 2 })}</td>
                <td className="num">{rate.toFixed(5)}</td>
                <td className="num">+{delta}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="note">
        Rates are blended across both TNB accounts, because the production lines are
        not cleanly separable by account. Every bill above reconstructs to the cent
        from its kWh and AFA rate — see <code>tests/tariff.test.ts</code>.
      </p>
    </main>
  )
}
