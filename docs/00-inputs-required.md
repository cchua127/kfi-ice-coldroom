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

### 4.1 §4.5's regression targets are on the legacy lumped basis and must not be reused

This resolves decision 2 without needing the reconciled model. Using Sept 2026 day 1:

| Spec §4.5 target | What it actually is | Value on the rebuilt model |
|---|---|---|
| tube ≈ 0.135 kWh/kg | Correct — true kWh/kg (710 ÷ 5,225 = 0.1359) | **keep** |
| big pool ≈ 0.060 kWh/kg | Metered big pool kWh ÷ **lumped** kg (1,300 ÷ 21,800 = 0.0596) | **0.1016** (1,300 ÷ 12,800) |
| cost of ice RM0.0617–0.0699/kg | **Tube line RM/kg at the frozen 0.484 rate** — `Meter - tube ice` col J (Sept avg 0.0643, Jun 0.0657) | **≈ RM0.058–0.059/kg** |

The big pool figure divides metered energy that **excludes** BIMC by a tonnage that **includes** it.
The cost-of-ice band is not a combined figure at all — it is the tube line alone.

Correct combined baseline, Sept day 1: `710 + 1,300 + (200 × 5.0) = 3,010 kWh` over `27,025 kg`
= **0.1114 kWh/kg**, giving **RM0.0580/kg** at the June site rate and **RM0.0593/kg** at August's.
Against the legacy master's RM0.0499/kg, restated cost of ice rises roughly **16%** — directionally
what §10 predicts, and the variance report should carry this number.

**Action:** replace §4.5's sanity band with the tube 0.135 kWh/kg check (which is sound) plus the
combined RM0.058–0.060/kg figure above. Do not gate on 0.060 kWh/kg or RM0.0617–0.0699/kg.

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

| # | Item | Blocks |
|---|---|---|
| 1 | `meter SMALL POOL vs elec.xlsx` | §10 — SMALL_POOL history for Dec 2025 / Jan 2026 |
| 2 | Coldroom sub-meter: meter number, CT multiplier, and readings for Jan–Aug 2026 | §4.4 site bridge has no baseline without it |
| 3 | Good Taste structure per §4.5: are `Pro` and `KFI`/`FM` two separate buyers each taking the crush quantity, or is `K` double-counting? What is the RM22.40 rate in column Y, and where do the blok go? | Outside sales migration and reported revenue |
| 4 | `SMALL_POOL.active_to`; `BIMC.active_from`; which TNB account each meter sits on | Reference seeding |
| 5 | Ocean Ice block size at RM15.00, and whether purchased ice enters `ice_kg` for cost per kg | §4.5 denominator |
| 6 | Public holiday source (Selangor) for the zero-cash soft warning | §7 |
| 7 | Whether dashboard "total sales RM" includes outside sales, and whether purchases are netted | §8 |
| 8 | Names, emails and roles for the three or four accounts; admin-set passwords acceptable? | Auth |
| 9 | Agreed parallel-run length and target cutover date | §11 |

Deployment credentials are deliberately excluded — per decision 4 the build is local-first.

Items 3, 4 and 5 block parts of the migration. Items 1 and 2 block specific history. Everything else
in §10 can now proceed: the layouts in §3 are complete enough to write the importers against.

---

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
