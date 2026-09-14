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
