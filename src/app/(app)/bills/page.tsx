import Link from 'next/link'
import { PrismaClient } from '@prisma/client'
import { requireUser } from '@/lib/session'
import { canWrite } from '@/lib/auth'
import { UploadZone } from '@/components/bill-upload'

const prisma = new PrismaClient()
export const dynamic = 'force-dynamic'

const money = (v: unknown) =>
  Number(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default async function BillsPage() {
  const user = await requireUser()
  const bills = await prisma.tnbBill.findMany({
    orderBy: [{ periodStart: 'desc' }, { accountId: 'asc' }],
    include: { account: true, document: true },
  })
  const pending = bills.filter((b) => b.status === 'PENDING_REVIEW')

  return (
    <main>
      <h1>TNB bills</h1>
      <p className="sub">
        The model reads the bill, the reconstruction checks it, and you confirm it.
        Nothing is confirmed automatically — this is money.
      </p>

      {canWrite(user.role) ? <UploadZone /> : null}

      {pending.length ? (
        <section className="panel">
          <h2>Waiting for review</h2>
          <ul className="billlist">
            {pending.map((b) => (
              <li key={String(b.id)}>
                <Link href={`/bills/${b.id}` as never}>
                  {b.account.accountNo} · {b.periodStart.toISOString().slice(0, 10)} to{' '}
                  {b.periodEnd.toISOString().slice(0, 10)}
                </Link>
                <span className="badge provisional">Pending review</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <h2>All bills on file</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Period</th>
                <th className="num">kWh</th><th className="num">AFA</th>
                <th className="num">Total RM</th><th className="num">RM/kWh</th>
                <th>Status</th><th>Document</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={String(b.id)}>
                  <td>{b.account.accountNo}</td>
                  <td>
                    <Link href={`/bills/${b.id}` as never}>
                      {b.periodStart.toISOString().slice(0, 10)}
                    </Link>
                  </td>
                  <td className="num">{Number(b.kwh).toLocaleString('en-MY')}</td>
                  <td className="num">
                    {b.afaRatePerKwh === null
                      ? '—'
                      : `${(Number(b.afaRatePerKwh) * 100).toFixed(2)} sen`}
                  </td>
                  <td className="num">{money(b.totalRm)}</td>
                  <td className="num">
                    {(Number(b.currentChargesRm ?? b.totalRm) / Number(b.kwh)).toFixed(5)}
                  </td>
                  <td>
                    <span className={`badge ${b.status === 'CONFIRMED' ? 'final' : 'provisional'}`}>
                      {b.status === 'CONFIRMED' ? 'Confirmed' : 'Pending'}
                    </span>
                  </td>
                  <td className="muted">{b.document?.filename ?? 'seeded, no PDF'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
