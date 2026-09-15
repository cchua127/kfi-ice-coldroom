# KFI Ice Ops — Source Review and Outstanding Inputs

**Status:** 11 of 12 source inputs received and decoded. One workbook and one dataset outstanding (§5).
**Spec reviewed:** `kfi-ice-ops-spec.md`, dated 14 September 2026.
**Reviewed:** 14 September 2026. No application code written yet.

---

## 1. Verification against the actual bills — all six tie to the cent

The six TNB PDFs were parsed and checked against §5.2's reconstruction. Every figure agrees.

Worked example, account 220275147610, June 2026 (`...1FA11D98...smart.pdf`):

| Bill line | PDF | Reconstructed |
|---|---:|---:|
| Jumlah Penggunaan Anda (kWh) | 68,207.00 | — |
| Tenaga (RM0.2703/kWh) | 18,436.35 | 18,436.35 |
| AFA (RM0.0259/kWh) | 1,766.56 | 1,766.56 |
| Kapasiti (RM0.0883/kWh) | 6,022.68 | 6,022.68 |
| Caj Rangkaian (RM0.1482/kWh) | 10,108.28 | 10,108.28 |
| Caj Peruncitan | 20.00 | 20.00 |
| Rebat (−RM0.02/kWh) | −1,364.14 | −1,364.14 |
| Caj Penggunaan Bulan Semasa | 34,989.73 | 34,989.73 |
| KWTBB (1.6%) | 531.25 | 531.25 |
| **Caj Semasa** | **35,520.98** | **35,520.98** |
| Pelarasan Penggenapan | 0.02 | — |
| **Jumlah Bil Anda** | **35,521.00** | — |

**The 1–2 sen deltas found in the first review are the bill's own `Pelarasan Penggenapan` line.**
The reconstruction is exact; §5.2 can be implemented as specified and used as a hard gate.

Also confirmed directly from the PDFs:

- Tariff prints as **`Bukan Domestik Am Voltan Rendah`** — §3.4 correct.
- Rebate is an explicit entitlement: *"tarif terdahulu sebelum 1 Julai 2025 ialah Tarif D –
  Perindustrian Voltan Rendah… layak menerima rebat sebanyak 2 sen/kWh"*.
- Service tax (`Dengan ST`) is 0.00 on every line — §3.4 correct.
- Meter numbers 218503197 + 808503793 on account 7610; their kWh rows sum to 68,207, exactly the
  billed consumption. kW and kVARh rows must be captured but excluded from the sum, as §5 states.
- Declared load 80.50 kW against maximum demand 375.00 kW; security deposit RM79,366.13 — §12 item 4 correct.
- Six-month history panel matches §3.4 exactly (Jan 61,922 / Feb 75,345 / Mac 68,745 / Apr 80,702 /
  Mei 72,559 / Jun 68,207 kWh, with RM27,556.00 / 35,197.75 / 32,542.50 / 39,555.00 / 36,908.20 / 35,521.00).

Tariff facts independently confirmed as current: September 2026 AFA **+3.67 sen/kWh**, August **+3.80**.

### 1.1 One correction to §4.2

**All six bill periods are exactly calendar-aligned** (e.g. `01.06.2026 - 30.06.2026 (30 Hari)`).
§4.2's premise that periods "do not align with her calendar-month sheets" does not hold for these
two accounts. The daily-rate series in §4.2 should still be built — it costs nothing and is correct
either way — but the expected complexity is not there.

The straddle risk is nonetheless real: the bills print an AFA information box listing **two**
periods with different rates (May at RM0.0138, June at RM0.0259). Only one is charged here, but the
parser must read the rate from the **charge line**, not the information box, or it will pick the
wrong month.

---

## 2. Decisions taken (owner, 14 September 2026)

| # | Question | Decision |
|---|---|---|
| 1 | Build sequencing | Wait for all source files, then build in file order. |
| 2 | Cost-of-ice regression target | Owner to supply the reconciled model. **Now superseded — see §4.1**, which resolves it from the workbooks. |
| 3 | "Block" product mapping | Sydney and Good Taste = 12.5 kg bag; TCC and Burger = 100 kg block. **See §4.5 — the workbook shows a third rate that needs confirming.** |
| 4 | Deployment | Local-first; Caddy, Spaces and API-key settings as documented placeholders. |

---

## 3. Decoded workbook layouts

Sheet naming confirmed dirty as described: `'aug '` (trailing space, big pool), `apr1` (cash),
`dec25`, `mac`, `sept`, `july`. In-cell arithmetic confirmed (`D12 = 27+30`, `F17 = 88+13`).

### 3.1 `Daily rekod Ais.xlsx` — 12 sheets, `dec`…`nov`. Data rows 6–35(37), day in col A

| Col | Header | Formula | Truth |
|---|---|---|---|
| B | Cash Daily | value | From `daily cash ice` col D |
| C | Sales Outside | value | From `Ice Purchase` col N |
| D | TOTAL SALES | `=B+C` | RM |
| E | TOTAL KG | `=J+K+L` | kg |
| F | TOTAL Kwh | `=M+N+O` | **RM, not kWh** |
| G | % Kwh/sales | `=F/D` | RM electricity per RM sales |
| H | RM Kwh/kg | `=F/E` | RM electricity per kg |
| J/K/L | Tube / Big Pool / Small Pool | value | kg — **K is lumped, see §4.2** |
| M/N/O | Tube / Big Pool / Small Pool | value | **RM, not kWh** |

Rows 38 TOTAL, 39 `Total Ave` (`=B38/13`), 40–42 prior-month chain.

### 3.2 `Meter - tube ice - elec.xlsx` — 9 sheets, `jan`…`sept`. Data rows 8–38

`A` date, `B` meter reading (`=N`), `C` kWh (`=P`), `D` bags, `E` `=D*L`, `F` tong, `G` `=F*K`,
`H` total kg (`=E+G`), `I` `=C*M` (**RM**, header reads "kWh x 0.484"), `J` `=I/H` (**RM/kg**,
header reads "kWh/kg"), `K`=100, `L`=12.5, `M`=0.484 (per-row constants), `N` Mula, `O` Akhir,
`P` `=O−N`. Row 39 `1/10` carries the closing into the next month; row 41 `=C40/13`.

### 3.3 `meter BIG POOL vs elec.xlsx` — 10 sheets, `dec25`…`sept`. Data rows 6–36

`A` date, `B` `=S`, `C` kWh (`=U`), `D` **`=C+V` where `V`=429**, `E` baris, `F` `=E*R` (R=8),
`G` **BARU quantity, hardcoded 200 every day**, `H` tong kosong, `I` `=(F−H)*N` (N=100) big tong kg,
`J` `=G*O` (O=45) small tong kg, `K` **`=I+J` lumped total kg**, `L` **`=D*P*Q`** (P=0.484, Q=1.2) RM,
`M` `=L/K` (**RM/kg**, header reads "kWh/kg"), `S` Mula, `T` Akhir, `U` `=T−S`, `V`=429.

### 3.4 `daily cash ice.xls` — 10 sheets, `dec25`…`sept`. Data rows 5–35

`A` date, `B` shift 1, `C` shift 2, `D` total, `E` Pro Sheet Rpt, `F` Fatman (**flat 1,664.00/day**),
`G` total (duplicates D), `H` cumulative, `I` daily average, `J`/`K` prior-month comparison,
`L`–`P` working columns incl. `O` Ratono and `P` Dif. Only A/B/C are source data; the rest derive or
are excluded per owner instruction.

### 3.5 `Ice Purchase sales outside.xls` — 12 sheets, `jan`…`dec`. Data rows 6–36

`B` date; `C`/`D`/`E` Ocean Ice DO no / quantity / RM15 per unit; `F`/`G` Sydney at RM3.30;
`H`/`I` TCC at RM21.00; `J`/`K` Good Taste free-text `blok/crush` and RM; `L`/`M` Burger at RM26.00;
`N` row total, which feeds `Daily rekod` column C. Columns `P`–`AI` are a Good Taste working area
(Pro / KFI / FM sub-splits for blok and crush) plus `AH` Dif. Unit prices live in the **header text**
(`'3.30/unit '`, `'21.00/unit '`, `'26.00/unit'`, `'15/unit'`), not in a dated price list.

---

## 4. Findings that change the specification

### 4.1 §4.5's regression band is a residual calculation, not a sum of lines

**Correction to the first review.** I previously reported that the RM0.0617–0.0699/kg band was the
tube line alone. That was wrong. `KFI Management Reports DRAFT v6`, sheet `R5 Cost Trend`, column
"2026 restated" reads Jan 0.0617, Feb 0.0638, Mar 0.0654, Apr 0.0646, May 0.0687, Jun 0.0699 — the
band exactly. It is a combined cost-of-ice figure.

The band is still unusable as a regression test, for a stronger reason. R5 states its own method:

> Legacy method = (Total TNB − coldroom @0.484 − RM5,200) / produced kg

This is a **residual**: every kWh on site that is not coldroom or water is charged to ice. That is
precisely the practice §4.4 forbids — *"the residual is flagged as unaccounted, never pushed into the
ice line… the legacy report's fatal flaw was using 'Ice' as a balancing figure."* The restated column
re-runs the same residual at actual tariff rather than 0.484; it does not change the method.

Computed from the workbooks as the rebuilt engine will compute it — `tube + big pool` metered plus
`BIMC blocks × 5.0`, over `tube + big-pool + BIMC` kg:

| 2026 | Jan | Feb | Mar | Apr | May | Jun |
|---|---:|---:|---:|---:|---:|---:|
| Sum-of-lines kWh/kg | 0.1177 | 0.1176 | 0.1146 | 0.1155 | 0.1176 | 0.1160 |
| Sum-of-lines RM/kg | 0.0570 | 0.0569 | 0.0555 | 0.0559 | 0.0569 | **0.0604** |
| R5 "2026 restated" RM/kg | 0.0617 | 0.0638 | 0.0654 | 0.0646 | 0.0687 | **0.0699** |

The June gap is **15.7%**, and it is the unaccounted balance landing on ice. Reproducing the band
would mean reproducing the defect.

**Three different cost-of-ice figures are in circulation for the same months.** The master workbook
she maintains and the management report disagree by 36% on June:

| 2026 RM/kg | Jan | Feb | Mar | Apr | May | Jun | Basis |
|---|---:|---:|---:|---:|---:|---:|---|
| `Daily rekod` F38/E38 | 0.0562 | 0.0644 | 0.0577 | 0.0549 | 0.0539 | **0.0522** | Sum of lines at frozen 0.484, with `+429` and `×1.2` |
| Rebuilt engine | 0.0570 | 0.0569 | 0.0555 | 0.0559 | 0.0569 | **0.0604** | Sum of lines at actual site rate, loads itemised |
| R5 "2026 restated" | 0.0617 | 0.0638 | 0.0654 | 0.0646 | 0.0687 | **0.0699** | Site residual at actual rate |
| R5 "2026 legacy" | 0.0597 | 0.0594 | 0.0582 | 0.0632 | 0.0673 | **0.0711** | Site residual at 0.484 |

The kg base agrees across all four (June: master 879,992 against computed 879,988). The spread is
entirely in the RM. The variance report in §10 should present this four-way reconciliation, because
the rebuilt figure is **+15.7% against the master** and **−13.6% against the management report** —
whichever one a reader has in mind, the other direction will look like an error unless both are shown.

**Action:** the regression test is the sum-of-lines row above, not the band. Keep the tube
0.135 kWh/kg check — `R6 Tube Machine` independently reports 0.1336–0.1355 for Jan–Jun against my
0.1353–0.1355, and its kWh and kg totals match my extraction to the kilogram, which validates the
importer arithmetic. Expect §10's variance report to show cost of ice **falling** ~14% against the
legacy figure, not rising: the legacy number was inflated by the residual, and the tariff rise only
partly offsets that.

Also note the still-live §4.5 target for big pool: at 0.060 kWh/kg it remains the lumped ratio.
On the separated model big pool runs ≈0.105 kWh/kg (Jun: 37,360 kWh ÷ 354,000 kg).

### 4.2 Defect 7 is worse than the spec states

The spec says the master's ratio column *headers* are mislabelled. In fact the **data columns
themselves hold ringgit**: `Daily rekod` F/M/N/O, headed "TOTAL Kwh", are `kWh × 0.484` copied from
the detail files (tube col I, big pool col L). Verified: tube `I8 = 710 × 0.484 = 343.64` → master
`M6 = 344`; big pool `L6 = 1,729 × 0.484 × 1.2 = 1,004.20` → master `N6 = 1,004`.

**There is no kWh figure anywhere in the master workbook.** Every "kWh" in it is money at a frozen
2025 tariff. The parallel-run diff (§11) must compare F/M/N/O against **RM**, not kWh, or every row
will appear to disagree.

### 4.3 BIMC output has never been recorded

`meter BIG POOL` column G ("BARU (Quantity)") is the literal constant **200 on every single row of
every sheet**. BIMC production is an assumption, not a measurement, and its 9,000 kg/day flows into
the lumped total kg and therefore into every kg, RM/kg and kWh/kg figure ever reported.

Consequences: the §6 entry screen's "BIMC: small tong count" is **new data capture that has never
existed**; and all migrated BIMC history is synthetic and must be marked `MODELLED`, not imported as
if measured. The migration needs an explicit rule — suggest importing 200/day flagged as an estimate.

### 4.4 Two new defects not in the spec's list

- **Negative meter landmine.** On the current month's first unfilled row the `Akhir` cell is blank,
  so the difference formula evaluates against zero: tube `P21 = −2,151,320`, big pool `U19 = −7,297,590`.
  Today these are harmless only because the adjacent kWh cells are also blank. Any stray entry
  propagates a seven-figure negative into the monthly total. The `>= previous closing` rule in §7
  plus a null-opening guard covers this.
- **Second hardcoded divisor.** `Daily rekod` row 39 uses `=B38/13` across the sheet but `I39 = I38/16`
   — a different divisor, on an empty column. Same class as defect 3.

Spec defects 1, 2, 3, 4, 5 and 6 are all confirmed verbatim, including the tube sheet's row 42
mixing `aug!C41` with `jun!D41`–`jun!J41`, and the `'aug '` trailing-space reference in big pool `S6`.

### 4.5 Good Taste is more complex than "split into two integer columns"

Defect 6 confirmed exactly: `sept` J13 (day 8) holds the date serial **21002 = 1957-07-01**, from the
text `"7/57"`. Reversal is reliable — month → blok, two-digit year → crush — and cross-checks against
the working columns (`U13 = 7`, `AA13 = 57`).

But the RM does not come from a simple two-column split. `K = Z + AE`, where `Z` and `AE` are two
parallel sub-streams (headed `Pro`, `KFI`, `FM`) **both priced at RM3.30 on the crush quantity**.
For day 1: `Z6 = 55 × 3.30 = 181.50`, `AE6 = 55 × 3.30 = 181.50`, `K6 = 363.00`. The 7 blok are not
priced into `K` at all, and a **third rate of RM22.40** appears in column Y that is in neither the
spec's price table nor the header prices.

**This needs the owner's answer before outside sales can be migrated** — see §5. It is a revenue
figure: `K` feeds `N`, which feeds `Daily rekod` column C.

### 4.6 Prices are not dated anywhere

Unit prices live in header text (`'3.30/unit '`, `'21.00/unit '`, `'26.00/unit'`, `'15/unit'`) and in
per-row constants. There is no price history to migrate, so the §3.1 `price` table will be seeded
from these as at the earliest migrated month, exactly as §2 anticipates.

---

## 5. Still outstanding

Resolved since the first review: the small pool workbook, the Good Taste rule, and the cost-model
provenance are all now closed.

| # | Item | Blocks |
|---|---|---|
| 1 | **Coldroom sub-meter**: number, CT multiplier, readings Jan–Aug 2026 | §4.4 site bridge has no baseline. R5 shows the legacy model valued coldroom by dividing an RM allocation by 0.484 — the circularity §4.4 calls out — so there may be no reading history at all. Needs confirming. |
| 2 | **The block ledger gap** (§7.2): is 200 a mould count or a harvest count? | Decides whether BIMC production is overstated 11.5% and whether ~RM39.5k H1 of ice left unpapered. One watched harvest or one stock count settles it. |
| 3 | **CCTV audit sheets** — source of the pasar product split in R3 | Channel-mix reporting (§8) and the pasar price list |
| 4 | **Worker ledger** — source of big pool FOC and the Feb purchase discrepancy (274 vs 218 blocks) | FOC history for BIG_POOL |
| 5 | **2025 records** — R5 notes they were not provided | Year-on-year trend before 2026 |
| 6 | `SMALL_POOL.active_to`; `BIMC.active_from` (R5 implies the China machine arrived 2025 and the 30HP compressor Mar 2024 — exact dates needed) | Reference seeding |
| 7 | Ocean Ice block size at RM15.00, and whether purchased ice enters `ice_kg` | §4.5 denominator |
| 8 | Public holiday source (Selangor); whether dashboard "total sales RM" includes outside sales and nets purchases | §7, §8 |
| 9 | Names, emails and roles for the three or four accounts; parallel-run length and cutover date | Auth, §11 |

Only items 1 and 4 block migration, and only for specific history. Everything else in §10 can proceed.

## 6. Schema gaps to resolve during the build

| Gap | Consequence |
|---|---|
| `app_user` never defined, referenced by three tables | Schema will not build |
| No table for derived daily costs | §4.2 must store them and flip `PROVISIONAL`→`FINAL` |
| No table for published AFA rates | §10 needs September costed at +3.67 before any bill exists |
| `tnb_bill` lacks `invoice_no`, `days`, `rebate_rm`, `previous_balance_rm`, `rounding_rm`, `load_factor`, per-meter readings | **Confirmed necessary** — `Pelarasan Penggenapan` and `Baki Terdahulu` are printed bill lines and §5.2 cannot tie `total_rm` without them |
| `afa_sen_per_kwh numeric(8,4)` named in sen, parser emits RM (0.0380) | 100× error risk |
| `cash_sales_daily.total` described as generated, not declared | Comment and DDL disagree |
| `production_unit.kg_per_unit not null` with no value for `BARIS` | Constraint unsatisfiable |
| `outside_sale` has no unique constraint | Duplicate rows on double submit |
| No edit history on daily rows | Conflicts with the stated goal that restating never silently rewrites history |
| `meter_reading` opening "derives from prior day" | Undefined for first day and for gaps — and see the §4.4 landmine |

### 6.1 Contradictions and the defaults assumed

| Contradiction | Default taken |
|---|---|
| §8 wants a max-demand-over-declared-load alert; §5.3 says build no alerts off those fields | Follow §5.3 — capture for the record, no alert. Confirm at review. |
| §4.2 assumes non-calendar bill periods; all six bills are calendar-aligned | Build the daily rate series anyway; read the AFA rate from the charge line, never the information box (§1.1) |
| §3.4 quotes Jun 7610 at RM35,521.00; §5.2 worked check gives RM35,520.98 | Both are right — 35,520.98 is `Caj Semasa`, 35,521.00 is `Jumlah Bil` after `Pelarasan Penggenapan`. Fixtures must distinguish the two. |

---

## 7. New scope from `KFI Management Reports DRAFT v6` and the small pool workbook

These two files introduce domains the build specification does not model at all. They are
requirements input, not data sources, and they materially widen v1.

### 7.1 FOC (free-of-charge) ice is a first-class quantity and is not in the schema

| Line | H1 2026 FOC | Value | Where recorded |
|---|---:|---:|---|
| BIMC (China machine) | 6,272 blocks, 282.24 t | RM78,923 | Per shift in the `-baris` sheets |
| BIG_POOL | 103.5 blocks | — | Worker ledger only, never transcribed |
| TUBE | unknown | — | **Not recorded anywhere** |

FOC runs at **25.6% of blocks moved** and is flat across every day of the week (23.9–27.0%), which
the report reads as systemic rather than demand-driven. It concentrates in one shift: **Shift N 35.8%
against Shift M 10.0%**.

The schema needs an FOC quantity per line per shift per day, and every kg, RM/kg and kWh/kg figure
must state whether it is on **produced**, **sold** or **moved** volume. The spec's `production_daily`
has one `quantity` column and no concept of FOC, so cost per kg is currently ambiguous by ~25% on the
block lines.

### 7.2 Shifts exist at the production level, not just at the cash counter

The `-baris` sheets carry **two rows per date — Shift M and Shift N** — with per-baris detail
(`Baris 1`…`Baris 8`), quantity, FOC, total and % FOC. `cash_sales_daily` models two shifts, but
`production_daily` does not. Given the Shift M/N FOC split above, production must be keyed by shift
or the single most actionable control finding in the report becomes invisible.

The report also verifies shift cash to the ringgit: `big × RM26 + small × RM13 = recorded shift cash`,
six for six on the June sample. **Those two pasar unit prices are not in the §2 price table** and must
be seeded — they are what makes the reconciliation possible.

### 7.3 The block ledger gap — an open control question, not a modelling one

3,130 blocks H1 (~23 per fill, 11.5% of the 200 positions) are produced-but-never-moved, worth
~RM39,460. The report tests and rejects storage loss, time-based loss and counter loss, and narrows to
two readings: either 200 is a mould count and real yield is ~177 (bookkeeping fix, cost of ice
restates +2.7%), or 200 real blocks exist and ~141 t left unpapered (floor investigation).

This is **decision-relevant to the build**: if the harvest count wins, `BIMC` production should be
captured as rows actually harvested — which is a different entry field from the flat 200 — and the
`bimc_kwh_per_block` assumption moves from 5.0 (booked) to **5.65 (sellable)**, a figure the report
already derives. Both are single-row edits in `cost_assumption`, exactly as §12 item 2 anticipates.

### 7.4 Two more data sources exist that were not in the §10 file list

- **CCTV audit sheets** — the source of R3's pasar product split (Big+Small blocks / Tube tong /
  Crushed / Bags & misc, monthly RM). The report notes the verification column has been **empty for
  all 7 months**, so the variance column compares against nothing.
- **Worker ledger** — holds big pool FOC and shows Feb purchases of 274 blocks against 218 in the
  outside-sales file (RM840 timing difference, unverified).

### 7.5 Small pool: a second small-block weight, and a different loader

`meter SMALL POOL vs elec.xlsx` has four sheets — `jan`, `dec25` and their `-baris` counterparts.
The daily sheets mirror big pool but with **`K = 38` kg per small block** (against BIMC's 45 kg) and
**`Q = 0.38`** as the cost loader (against big pool's 1.2). R5 confirms the drift: *"small-block weight
convention 38 kg (2024) vs 45 kg (2026) inflates recent kg ~1–3%"*.

`production_unit` must therefore carry both weights with correct `effective_from` dates, and they
belong to different lines — this is not one product that changed weight.

### 7.6 Quantities are fractional

Big pool runs "14.7 rows avg × 8 cans, **a real, varying count incl. half-rows**", and Good Taste blok
quantities appear as 6.5 and 8.5. `production_daily.quantity` is already `numeric(12,2)`, but the
`blocks = baris × blocks_per_baris − tong_kosong` derivation and the `tong_kosong <= baris ×
blocks_per_baris` check must both tolerate fractions.

### 7.7 An operations finding the dashboard should carry

`R6 Tube Machine` fits 193 days: **49.1 kWh/day fixed, 0.1292 kWh/kg variable**, with an idle day at
10 kWh and zero production. It concludes the tube meter is clean — no passengers — so 0.134 kWh/kg is
genuinely the machine, against a textbook 0.06–0.09, and July drifted to 0.1362, the worst on record.
This is exactly the "flat kWh/kg with rising RM/kg means tariff, not plant" decomposition §8 asks for,
except here the plant signal is real. The kWh/kg-by-line chart should make this visible.

### 7.8 Good Taste — resolved

Owner rule: Good Taste buys two products — **bags of crushed ice**, and **ice blocks cut into 1/8**,
the blocks slightly dearer. **Take the production (`Pro`) columns; `KFI` and `FM` are an internal
split of the same figures, not separate customers**, so they must not be summed.

This settles the apparent double-count: `K = Z + AE` adds an internal split to itself. Migrated
Good Taste revenue must come from the Pro columns alone, priced at **RM3.30 per crush bag** and
**RM22.40 per block** (column Y — between TCC's RM21.00 and Burger's RM26.00, consistent with
"slightly more expensive"). The free-text `blok/crush` cell resolves to blok = first number,
crush = second; the corrupted `1957-07-01` reverses to `7/57` and cross-checks against the working
columns.

One narrow ambiguity remains, and it does not block: the two `Pro` columns (`T` and `AA`) disagree on
roughly a quarter of days (e.g. 50 against 55 on 10 September). The importer will take `Pro` and list
every disagreement in the dry-run diff for confirmation rather than guessing.

---

## 8. Further findings from the migration build

Found while writing the importers against the actual workbooks. Each is now
covered by a test.

### 8.1 The ice-purchase workbook runs Oct 2025 to Sept 2026, not Dec 2025 to Nov 2026

§10 of the specification describes the sheets as running "roughly Dec 2025 to
Nov 2026". For this workbook that is wrong in a way that matters: the sheets
named `oct` and `nov` are **October and November 2025**, and their own month
markers say so (`Oct'25`, `Nov'25`). Inferring the year from the sheet name puts
them a full year out and would have loaded 2025 trading as 2026.

The importer therefore resolves every sheet from its own month marker first and
falls back to the name only when there is none, reporting which it used.

### 8.2 Column layouts are not stable between sheets

Customers come and go, and everything to their right moves:

| Sheet | Columns | Good Taste at | Extra customers |
|---|---:|---|---|
| Oct 2025 | 41 | P | Wai Mah, The Wet World, Hypecircus |
| Nov 2025 | 39 | N | Snow Theme Park, The Wet World |
| Dec 2025 – Sept 2026 | 35 | J | — |

The month marker moves with them, from N2 on a 35-column sheet to T2 on the
41-column one. A fixed column map would have imported one customer's quantities
as another's, silently. The importer resolves every column by its header label.

**Four customers appear that are in neither the specification nor the price
list**: Wai Mah, The Wet World, Hypecircus and Snow Theme Park. Their quantities
are read but not loaded, because nothing records which product they buy — that
is outstanding input.

### 8.3 The price rise was June 2026, not January

Read from the unit-price labels in the sheet headers:

| | Oct 2025 – May 2026 | From June 2026 |
|---|---:|---:|
| Sydney | RM 3.00 | RM 3.30 |
| TCC | RM 19.00 | RM 21.00 |
| Burger | RM 24.00 | RM 26.00 |
| Good Taste crush | RM 3.00 | RM 3.30 |
| Good Taste blok | RM 22.40 | RM 22.40 |
| Ocean Ice (purchase) | RM 15.00 | RM 15.00 |

This explains the specification's "Good Taste — RM 3.00 / 3.30": those are the
old and new prices, not two products. Report R3 sees the same rise in the cash
data ("+9.4% vs Apr — June price rise realized").

The seed originally dated the current prices from 2026-01-01, which would have
restated five months of invoices at prices that did not yet apply. Corrected to
two epochs.

### 8.4 A missing formula understates May 2026 by 9,000 kg

`meter BIG POOL vs elec`, sheet `may`, row 36 (31 May): the BIMC block count is
present (200) and the 45 kg factor is present, but **the kg cell holds no
formula at all**. The sheet reports zero kg for that day's China-machine output
while still booking the blocks.

May total kg is therefore understated by 9,000 kg, which flows into the master's
TOTAL KG and every May ratio — kWh/kg reads 0.1176 where it should read 0.1164.
Small, but it is exactly the class of error the rebuild removes: the importer
derives kg from the block count and the dated unit weight, never from a kg cell
that may or may not carry its formula.

### 8.5 The earliest day of a meter series needs its opening reading

Each meter row carries a Mula (opening) and an Akhir (closing), and the opening
is the previous day's closing. For the first row of the earliest sheet there is
no previous day in the data, so that day's consumption is lost unless the Mula
itself is imported as a reading. On the tube meter this is 1 January 2026 —
10 kWh, which report R6 independently records as an idle day.

The importer now imports that opening as a reading dated the day before, and a
real closing for the same date always takes precedence over it.

### 8.6 The small pool `-baris` sheets are block types, not shifts

Correcting an earlier reading. Each date carries two rows, and they are the BIG
and SMALL block types, not two shifts: the BIG row books 1 baris of 8 and the
SMALL row 6 baris of 23, with FOC recorded against each. Report R1's Shift M and
Shift N split belongs to the China machine worker ledger, which is not among the
supplied workbooks.

These sheets are the only FOC record in the supplied data.

### 8.7 The master workbook is not an import source

`Daily rekod Ais` is a roll-up of the detail files with the same numbers re-typed
by hand. Importing it would double-count, so it has no parser. It is the
comparison target for the parallel-run check in §11.

---

## 9. Found by the parallel check

Running the rebuilt system against `Daily rekod Ais` for August 2026: **186 fields
agree, 31 differ, and every difference is the same one.** Cash, total kilograms,
tube kilograms, big pool plus BIMC kilograms, tube kWh and big pool kWh all tie
on all 31 days.

### 9.1 Good Taste blocks — resolved, with a residual worth knowing

**Resolved by the owner: a Good Taste block is charged at RM26.40.**

That is eight pieces at the RM3.30 crush rate. The crush rate was RM3.00 before
June 2026, so the block price is seeded as RM24.00 from October 2025 and RM26.40
from June 2026 — consistent with every other customer's June rise. The RM22.40 in
column Y of the source sheet is not what the sheet's own formula charges and is
not used.

**A residual difference remains, and it is a real one.** The sheet does not bill
blocks — it bills `(T + AA) x crush rate`, where `AA` is the crush bags and `T`
is a **counted** tally of the pieces the blocks yielded. `T` is close to eight
per block but not fixed: across the months checked it runs 7.7 to 8.2. So on days
where a block did not yield eight usable pieces, the sheet charges less than
eight pieces' worth and the system charges the full block.

After the correction, against `Daily rekod Ais`:

| Month | Agree | Differ |
|---|---:|---:|
| Jan 2026 | 233 | 15 |
| Mar 2026 | 230 | 18 |
| Jun 2026 | 221 | 19 |
| Jul 2026 | 221 | 27 |
| Aug 2026 | 223 | 25 |

Every remaining difference is an exact multiple of the crush rate of the day —
RM3.00 before June, RM3.30 after — which is the piece drift and nothing else.
Roughly half the days agree exactly, on the days a block yielded eight.

**The question for the owner, before cutover:** is Good Taste invoiced per block
ordered, as the price implies, or per piece delivered, as the sheet computes? The
system now does the former. If the answer is the latter, the entry screen needs a
piece count rather than a block count, and this is a change to how revenue is
recognised, not a rounding matter.

### 9.2 The seed was not convergent

Found while correcting the price above, and worth recording because it would have
mis-stated history quietly.

An earlier version of `prisma/seed.ts` dated every price from 2026-01-01.
Correcting it to two epochs — 2025-10-01 and 2026-06-01 — added the new rows but
left the old ones in place, because the seed only ever upserted. A price resolved
"as at 2026-01-01" then matched the stale January row rather than the October
one, and five months of history imported at June prices.

The parallel check is what surfaced it: January showed 31 differences where
August showed 25, with gaps that were not multiples of any rate. The seed now
deletes any epoch it no longer declares, for the pairs it manages, so re-seeding
converges instead of accumulating.

---

## 10. The owner's LIVE cost template

A file arrived after the build: `KFI_Ice_Cost_LIVE_TEMPLATE_4.xlsx`, eleven
sheets, owner-maintained, covering January to June 2026. It is not one of the
six workbooks this system replaces. It is the owner's own attempt at the
question this system exists to answer — where the electricity goes — and it
gets considerably further than the six do.

Everything in it is now implemented. `tests/workbook-template.test.ts` holds the
implementation to the template's own figures, from a machine dump of the file
rather than transcription, so a disagreement there is a disagreement between two
implementations and not a typing slip. All 57 assertions pass across all six
months.

### 10.1 What it supplied that was genuinely missing

The site bridge read 46.7% unaccounted because four consumers had no home and
three more had assumptions seeded but never used. The template names all seven:

| Consumer | Basis | Was it in the system? |
|---|---|---|
| 30HP brine compressor | 340 kWh/day | assumption seeded, never read |
| Office and CCTV | 36 kWh/day | assumption seeded, never read |
| Crusher | 10 kWh/day | assumption seeded, never read |
| Water, delivered | 0.65 kWh/t | assumption seeded, never read |
| Water, ice feed | 0.45 kWh/t | **new** |
| Coldrooms, tenant | RM compilation ÷ 0.484 | no path at all |
| Ice storage D10-D12 | invoiced RM ÷ 0.543 | no path at all |

Three new dated assumptions came with it: the legacy coldroom factor
(RM0.484/kWh), the tenant billing rate (RM0.543/kWh) and the ice-feed water
intensity (0.45 kWh/t).

On June 2026 data the residual falls from 46.7% to **1.6%**.

### 10.2 The correction to cost of ice

The template's ice total is tube + big pool + old small pool + the China machine
**plus the 30HP compressor plus the D10-D12 storage rooms**. This system's was
the four production lines alone.

That was wrong, and wrong in the direction that flatters. The compressor freezes
the big pool and makes no ice of its own; D10-D12 holds this plant's ice before
it is sold. Both are cost of ice by any reading, and excluding them moved the
difference into the site residual — a quieter version of the same mistake the
legacy report made by treating ice as the balancing figure.

Cost of ice is therefore **about a sen per kilogram higher** than this system
reported before. On June: RM0.0699/kg against RM0.0604/kg on the old definition.
The figure going up is the correction working.

`daily_energy_use` holds the support plant per day, and `MonthlySummary.supportKwh`
breaks it out so the two definitions can be reconciled rather than guessed at.

### 10.3 RESOLVED: ice-feed water counts as ice

**Owner, 15 September 2026:** yes, the water that becomes the ice belongs in
cost of ice. With two qualifications worth recording, because both are right:

> "we never really figured out a way to quantify it exactly, since the water is
> free, just that the electricity bill should be split to ice. However we think
> it is too menial to break it down this way."

The water *is* free — it comes out of the tubewell — so nothing is being costed
except the electricity of pumping and filtering it. That is what the 0.45 kWh/t
intensity represents, and it is an estimate, flagged as one.

**On "too menial": correcting a figure stated earlier in this section.** The
first draft of §10.3 said the decision was worth "about a third of a sen per
kilogram". That was wrong by roughly a factor of fourteen. The real figure:

```
0.45 kWh/t  ÷ 1000  ×  RM0.52071/kWh  =  RM0.000234/kg  =  0.023 sen/kg
```

On June 2026 that is **RM206 on an ice bill of RM61,670**, and it moves cost of
ice from RM0.0699/kg to RM0.0701/kg. The owner's instinct was correct: the
amount is menial.

It is included anyway, for two reasons that have nothing to do with the amount.
It is the correct treatment, and a system that gets the small allocations right
is the one you can believe about the large ones. And it costs the office
nothing: `WATER_DELIVERED` is the only water figure anyone keys, monthly, while
the ice-feed side is struck per day against the ice actually made. There is no
"breaking it down" for anyone to do.

`energy_use.counts_as_ice` for `WATER_ICE_FEED` is now `true`. Keeping the two
water intensities separate is what made the decision expressible at all — a
single water line could only have been all ice or none, and it is neither.

The crusher stays out, on firmer ground than a convention: it acts on ice
already made and already costed, so counting it would charge the same tonnage's
energy twice.

### 10.3a What the workbook-template test now pins

`tests/workbook-template.test.ts` reproduces the *template*, which excludes
ice-feed water from ice. It therefore passes `countsAsIce: { WATER_ICE_FEED:
false }` explicitly rather than relying on the default.

That matters for anyone changing a convention later. Without the override the
test would have started failing the moment this decision was taken — and a
convention change is not a disagreement about arithmetic, so it must not read
as one. A test that reproduces an external artefact has to name the artefact's
assumptions.

### 10.4 The coldroom back-inference — the worst thing in the template

The template recovers coldroom kWh by dividing the ringgit compilations by
RM0.484/kWh. That is the frozen pre-July-2025 tariff — defect 1, the reason this
rebuild exists — used as a divisor.

It is circular: it recovers a quantity from a price. The quantity is only as
good as a rate that has been stale for over a year, and every coldroom figure
downstream inherits it, including the tenant margin the business decides pricing
on.

It is implemented anyway, because the alternative is the coldroom being simply
absent from the bridge, which is what produced the 46.7% residual. But:

- the sub-meter is always preferred, and there is a field for it;
- the derived figure is `MODELLED` and its basis string starts `BACK-INFERRED:`;
- the month-close check **flags every month that leans on it**;
- the entry screen warns before the month is saved;
- the dashboard says so.

**This is the single highest-value outstanding item in the whole system.** One
meter reading a month removes a stale rate from the tenant margin, the site
bridge, the D10-D12 allocation and cost of ice. The meter is confirmed present;
only its number, CT multiplier and readings are missing.

### 10.5 RESOLVED: the pre-June counter prices

**Owner, 15 September 2026:** "the counter price only got revised this year."
One revision, in June 2026, which is the same event that moved every outside
price. The template's prefill is therefore evidence, not a guess, and the
pre-June epoch is now seeded.

Two of the three prices were unambiguous in the template's own cells:

| Counter line | Jan–May | Jun | Source |
|---|---|---|---|
| Big block | RM24 | RM26 | column X, flat at 24 for five months then 26 |
| Tube tong | RM22 | RM22 | column AM, flat at 22 throughout |
| Small block | **RM12** | RM13 | see below |

**The small block needed deciding.** The template's column AK reads
13, 12, 12, 12, 13, 13 — which is not a price series, because AK is an *average*
that the template solves for as a residual: it takes shift cash, subtracts big
blocks, tongs and crush, and divides by units. Every error upstream lands there.

RM12 is the answer, on two grounds. Three of the five pre-June months say 12.
And the June revision moved every product by 8–10%:

| | Before | After | Move |
|---|---|---|---|
| Sydney bag | 3.00 | 3.30 | +10.00% |
| Good Taste crush | 3.00 | 3.30 | +10.00% |
| TCC block | 19 | 21 | +10.53% |
| Burger block | 24 | 26 | +8.33% |
| Counter big block | 24 | 26 | +8.33% |
| **Counter small block at 12** | **12** | **13** | **+8.33%** |
| Counter small block at 13 | 13 | 13 | 0.00% |

RM12→13 lands on exactly the big block's and Burger's figure. RM13→13 would make
the small block the only line in a general price rise that did not rise. The
13s in January and May are the residual absorbing error, not a price.

This is an inference, and it is labelled as one in the seed note. It is a
different kind of inference from the one §9.2 warns about: that was a seed
quietly resolving to a stale epoch nobody had declared, where this is a stated
epoch with its reasoning attached and a check — the counter reconciliation in
`src/lib/checks.ts` — that will contradict it the moment counter units are
recorded for a pre-June month.

**What would overturn it:** load any month from January to May with counter unit
counts, and the counter-reconciliation check prices them out against shift cash.
If RM12 is wrong the check flags it, per month, with the ringgit gap.

### 10.6 Smaller findings

- **The template's CHECKS sheet demands an exact RM0.00 bill tie-out.** It can,
  because Excel rounds no intermediate column. This system stores every line to
  the sen, so the check is split: kWh must tie exactly (it does, by
  construction — the residual *is* the difference) and the ringgit carries a
  named 25-sen tolerance. Anything larger is reported as `unexplainedRm`, whose
  usual cause is not rounding at all but a TNB bill period straddling a month,
  costing days at two rates while the residual is struck at one.

- **February and March 2026 run a *negative* residual** in the template: the
  named loads claim more than the bill, by 508 and 3,271 kWh. That means a
  modelled assumption is set too high in those months — most likely the flat
  340 kWh/day compressor, in months when the pool ran less. The check reads a
  negative residual as over-modelling rather than under-metering and says so.

- **The coldroom margin is shrinking monotonically.** 9.8 sen/kWh in January,
  2.2 sen in June, on a fixed RM0.543 tenant rate against a blended tariff that
  AFA pushes up every month. Two more AFA moves of June's size and it is
  negative. There is a check for the crossing; the template has no equivalent.
  Reselling power at a fixed rate while buying it at a floating one is a short
  position on the tariff, and nobody has priced it as one.

- **The template's "Sydney pcs" convert at 12.5 kg**, confirming §7.8's reading
  that Sydney buys the 12.5 kg bag despite the "block" label on the price list.

- **FOC ran 19.8% to 30.0% of blocks moved** across the six months, against a
  15% threshold. Every month flags. That is not a threshold problem.

- **`WaterDelivery` gained `retail_m3`.** The template tracks retail water
  separately from the PKPS tubewell delivery and this system tracked only the
  latter. They are added at 1:1 — a cubic metre is a tonne — but kept in
  separate columns so the two sources stay separable when the second is
  reconciled.

---

## 11. The coldroom meter register — `E-2026.xls`

The file that closes §10.4, the item this log has called the highest-value
outstanding question in the system.

It is not the single whole-room sub-meter reading that was being asked for. It
is considerably better: a **per-room register**, about 29 rooms, each with its
own meter, read monthly and recharged at RM0.543/kWh. Nine months on file,
December 2025 to August 2026, 264 rows, plus an `ave` sheet holding per-room
monthly figures for calendar 2025.

It loads through the project's own pipeline — `scripts/import/extract.py` then
`parseColdroomMeter` then `scripts/import/load.ts` — and every sheet resolved
its month from its own date cell rather than its name.

### 11.1 The back-inference was invertible, which is not the same as correct

Every month the register and the owner's cost template both cover, the TOTAL
agrees exactly:

| Month | Register | Template (RM ÷ 0.484) |
|---|---|---|
| Jan 2026 | 53,297 | 53,297 |
| Feb 2026 | 53,797 | 53,797 |
| Mar 2026 | 62,489 | 62,489 |
| Apr 2026 | 53,980 | 53,980 |
| May 2026 | 58,481 | 58,481 |
| Jun 2026 | 55,035 | 55,035 |

This is not corroboration and should not be read as any. The template's ringgit
compilations were struck **from these very readings** at RM0.484/kWh, so
dividing back out by RM0.484 was an exactly invertible operation. It recovered
the right number for the wrong reason — and only for the total.

What it could not recover was the split, and the split is what cost of ice
depends on.

### 11.2 The register is internally sound, with fifteen explainable breaks

Checked mechanically across all nine months:

- `usage = current − last` on **every one of the 264 rows**. No breaks.
- `amount = usage × rate` on every row. No breaks.
- No negative usage anywhere.
- Fifteen places where a month's "last meter" does not equal the prior month's
  "current meter". Every one is explainable and none is a data error:
  - **A2, January** — the meter was replaced. December closes at 96,670 and
    January opens at 799 on a new register.
  - **D5, every month** — there are two physically different rooms both labelled
    D5, on registers around 564,767 and 486,831. Not a break at all; an artefact
    of matching by room code.
  - **D3 Jan, C4 Mar, D12 Mar** — a room re-let part-way through the month,
    appearing as two rows whose registers run continuously across the handover.

Usage and amount are therefore **derived, never stored**, per the standing
invariant. The sheet stores all four and they agree, which makes the stored pair
free evidence rather than a second source of truth: `COLDROOM_USAGE_MISMATCH`
and `COLDROOM_AMOUNT_MISMATCH` fire if anyone overtypes the sheet's arithmetic.

### 11.3 CORRECTION: own use follows the occupant, not the room number

**The owner's cost template charged a tenant's refrigeration to the cost of ice
in March 2026.**

D10, D11 and D12 are KFI's own rooms *by convention*. The template took that
convention as the rule. The register shows what actually happened:

| Room | March 2026 | Occupant |
|---|---|---|
| D10 | 3,568 kWh | KFI |
| D11 | 2,496 kWh | KFI |
| D12 | 1,653 kWh | **Zaidah Ibrahim (start 10/2/26 – 9/3/26)** |
| D12 | 76 kWh | KFI |

D12 was let out for most of the month. The register runs continuously across the
handover — the tenant's closing of 610,404 is KFI's opening — so both rows are
real and neither is a duplicate to discard.

- By room code: **7,793 kWh**
- The template's own ice-storage line: **7,717 kWh**
- Actually consumed by KFI: **6,140 kWh**

About **1,577 kWh** of a tenant's consumption was in cost of ice. At March's
blended rate that is roughly **RM746**.

The rule now lives in one named, exported, tested predicate — `isOwnUseTenant`
in `src/lib/import/parsers.ts` — and `CONVENTIONAL_OWN_USE_ROOMS` is kept
beside it purely so the importer can report where the two part company
(`COLDROOM_OWN_USE_DIVERGES`). March 2026 is the only month in the nine where
they diverge materially; February has the same tenant in D12 at 0 kWh.

### 11.4 Rows are keyed by position, not by room code

Both the duplicated-D5 rooms and the mid-month re-lets mean a room code is **not
unique within a month**. `coldroom_reading` is therefore keyed
`(period_month, row_no)`.

Keying on the room code would have silently dropped one row of each pair — in
March, either the tenant's 1,653 kWh or KFI's 76.

Room counts by month: 29, 30, 29, **31**, 29, 29, 29, 29, 29.

### 11.5 December's columns are shifted

`dec25` carries an extra "Inv No" column, putting its meters at D/E where every
other sheet has C/D, and shifting rate, usage and amount with them. This is §8.2
again in a new file.

Columns are resolved by **label** — "Current meter", "Last meter", "Rate",
"Tenants" — per the rule in `src/lib/import/layout.ts`. A positional map would
have read December's tenant column as a meter reading.

### 11.6 The coldroom letting business is nearly underwater

Now measurable rather than inferred, and it is the most commercially significant
thing in this section:

| | Jan 2026 | Jun 2026 | Aug 2026 |
|---|---|---|---|
| Spread, RM/kWh | 0.0981 | 0.0223 | **0.0102** |

The tenant rate is fixed at RM0.543 by contract; the blended tariff rose to
RM0.5328 in August. On 56,699 tenant kWh, August's whole margin is **RM579**.

One AFA move of a sen takes it negative. `src/lib/checks.ts` flags the crossing,
but the decision — reprice, or absorb it knowingly — is the owner's and should
be taken before it happens rather than after.

### 11.7 Three defects the real data exposed in this system

Found by loading the register, not by a unit test:

1. **The coldroom report showed RM0.00 cost and a full-recharge margin on any
   month with no confirmed bill.** `ctx.rate` is zero when no bill exists, and
   zero was being multiplied through as though the power were free — printing
   "RM30,597 margin" on March. Cost and margin are now blank on an uncosted
   month; what the tenants were billed is still shown, because that part *is*
   known.

2. **The monthly entry screen warned "nothing entered for the coldroom"** on
   months that were read room by room, because the fallback ringgit fields were
   empty. Validation now takes a `hasRegister` flag and suppresses the fallback
   warnings, on both the client and the server copy.

3. **The bill tie-out tolerance was a flat 25 sen.** That was calibrated when a
   month's statement was a dozen stored rows. Spreading the coldroom across 31
   days makes it about three hundred, each rounded to the sen, and 36 sen of
   accumulated rounding was being reported as a discrepancy. The tolerance now
   scales at half a sen per stored row above the 25-sen floor. What the check is
   actually for — a TNB bill period straddling a month, so days carry two rates
   while the residual is struck at one — is worth hundreds of ringgit and clears
   either bound by orders of magnitude.

### 11.8 Still open

- **The `ave` sheet holds per-room figures for calendar 2025** and is not loaded.
  It would extend the register back twelve months. Not done because it is a
  different shape (a block per room rather than a row per room) and nothing yet
  needs 2025 coldroom detail. The parser skips it explicitly rather than by
  accident, for the same reason the master workbook is skipped: loading it
  alongside `dec25` would double-count December.

- **"Usage 1" and "Usage 2"** split the rooms into two disjoint groups —
  A1–A3, B1–B3, C3–C7 against B4–B6, C1, C8, D1–D12. Almost certainly two
  feeders or two TNB accounts. The grouping is stable across all nine months
  except C1, which is sometimes unassigned. Captured on the reading row; nothing
  depends on it. **For the owner: what are the two groups?** If they map to the
  two TNB accounts, the site bridge could be reconciled per account rather than
  in aggregate.

- **Eleven rooms recorded no consumption at all in March**, and similar counts in
  other months. Vacant, or a meter nobody read — the register cannot tell those
  apart, and the report says so rather than assuming the rooms were empty.

- **Whether "KFI" in the tenant column is always the ice plant.** The predicate
  matches `KFI` on a word boundary, so "KFIX Trading" would not match, but a
  related entity billed as "KFI Trading" would. No such row exists in the nine
  months on file.
