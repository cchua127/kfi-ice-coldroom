import { notFound } from 'next/navigation'
import { PrismaClient } from '@prisma/client'
import { requireUser } from '@/lib/session'
import { canWrite } from '@/lib/auth'
import { reconstructBill } from '@/lib/tariff'
import { BillReview } from '@/components/bill-review'

const prisma = new PrismaClient()
export const dynamic = 'force-dynamic'

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireUser()

  let bill
  try {
    bill = await prisma.tnbBill.findUnique({
      where: { id: BigInt(id) },
      include: { account: true, document: true, readings: true },
    })
  } catch {
    notFound()
  }
  if (!bill) notFound()

  // Side by side: what the bill says, and what the arithmetic says it must say.
  const built = reconstructBill({
    kwh: bill.kwh.toString(),
    afaRatePerKwh: (bill.afaRatePerKwh ?? 0).toString(),
    previousBalanceRm: bill.previousBalanceRm.toString(),
    roundingRm: bill.roundingRm.toString(),
  })

  return (
    <main>
      <h1>
        {bill.account.accountNo} · {bill.periodStart.toISOString().slice(0, 10)} to{' '}
        {bill.periodEnd.toISOString().slice(0, 10)}
      </h1>
      <p className="sub">
        {bill.document
          ? `From ${bill.document.filename}`
          : 'Seeded from the bill on file; no PDF attached'}
        {bill.status === 'CONFIRMED' ? ' · already confirmed' : ''}
      </p>

      <BillReview
        billId={String(bill.id)}
        canWrite={canWrite(user.role) && bill.status !== 'CONFIRMED'}
        confirmed={bill.status === 'CONFIRMED'}
        fields={{
          kwh: bill.kwh.toString(),
          afaRatePerKwh: (bill.afaRatePerKwh ?? 0).toString(),
          energyRm: (bill.energyRm ?? 0).toString(),
          afaRm: (bill.afaRm ?? 0).toString(),
          capacityRm: (bill.capacityRm ?? 0).toString(),
          networkRm: (bill.networkRm ?? 0).toString(),
          retailRm: (bill.retailRm ?? 0).toString(),
          rebateRm: (bill.rebateRm ?? 0).toString(),
          currentUsageRm: (bill.currentUsageRm ?? 0).toString(),
          kwtbbRm: (bill.kwtbbRm ?? 0).toString(),
          currentChargesRm: (bill.currentChargesRm ?? 0).toString(),
          previousBalanceRm: bill.previousBalanceRm.toString(),
          roundingRm: bill.roundingRm.toString(),
          totalRm: bill.totalRm.toString(),
        }}
        expected={{
          energyRm: built.energyRm.toFixed(2),
          afaRm: built.afaRm.toFixed(2),
          capacityRm: built.capacityRm.toFixed(2),
          networkRm: built.networkRm.toFixed(2),
          retailRm: built.retailRm.toFixed(2),
          rebateRm: built.rebateRm.toFixed(2),
          currentUsageRm: built.currentUsageRm.toFixed(2),
          kwtbbRm: built.kwtbbRm.toFixed(2),
          currentChargesRm: built.currentChargesRm.toFixed(2),
          totalRm: built.totalRm.toFixed(2),
        }}
        meterReadings={bill.readings.map((r) => ({
          meterNo: r.meterNo, unit: r.unit, usage: r.usage.toString(),
        }))}
        notes={
          bill.parsedJson && typeof bill.parsedJson === 'object'
            ? String((bill.parsedJson as Record<string, unknown>).confidence_notes ?? '')
            : ''
        }
      />
    </main>
  )
}
