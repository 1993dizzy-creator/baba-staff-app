import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const evidence = JSON.parse(readFileSync(new URL('./aug-sep-reclose-evidence.json', import.meta.url), 'utf8'));
const units = n => BigInt(Math.round(Number(n) * 1000));
const money = n => Number(n) / 1000;

// Independent integer/rational calculation from captured transaction and line
// values. Never imports the app's summary or attribution implementation.
export function allocate(lines) {
  const groups = Map.groupBy(lines, l => l.reconciliation_id);
  const totals = {};
  for (const group of groups.values()) {
    const gross = units(group[0].matched_gross), difference = units(group[0].difference);
    const months = {};
    for (const l of group) {
      const month = l.sale_date.slice(0, 7);
      months[month] = (months[month] ?? 0n) + units(l.gross);
    }
    if (Object.values(months).reduce((a, b) => a + b, 0n) !== gross) throw Error('Gross mismatch');
    const parts = Object.entries(months).map(([month, value]) => ({ month, value: difference * value / gross, rem: difference * value % gross }));
    let remaining = difference - parts.reduce((a, b) => a + b.value, 0n);
    parts.sort((a, b) => a.rem === b.rem ? a.month.localeCompare(b.month) : a.rem > b.rem ? -1 : 1);
    for (const part of parts) {
      if (remaining > 0n) { part.value++; remaining--; }
      totals[part.month] = (totals[part.month] ?? 0n) + part.value;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([month, n]) => [month, money(n)]));
}

export function calculate(data = evidence) {
  const current = allocate(data.cardLines);
  const saleDates = Object.fromEntries(data.oldSales.map(s => [s.id, s.business_date]));
  const oldLines = data.normalized.filter(n => n.before.status === 'matched').flatMap(n => n.lines.map(l => ({
    reconciliation_id: n.id, sale_date: saleDates[l.sale_id], gross: l.gross,
    matched_gross: n.before.matched_gross_amount, difference: n.before.difference_amount,
  })));
  const removedAttribution = allocate(oldLines);
  const result = {};
  for (const month of ['2026-08', '2026-09']) {
    const txs = data.transactions.filter(t => t[2] === month + '-01');
    const sum = predicate => txs.filter(predicate).reduce((total, t) => total + units(t[4]) * BigInt(t[5]), 0n);
    const revenue = sum(t => t[1] === 'sales');
    const expense = sum(t => ['expense', 'expense_recognition'].includes(t[1]));
    const recognizedDifference = sum(t => ['card_settlement_difference', 'card_settlement_difference_reversal'].includes(t[6]));
    const adjustment = units(current[month] ?? 0) - recognizedDifference;
    const corrections = data.originals.filter(t => month === '2026-08' ? t.id === 1055 : [2191,2192].includes(t.id));
    const offset = corrections.reduce((a,t) => a + units(t.id === 1055 ? t.source_snapshot.augustRentExpenseRecognition : t.amount),0n);
    const rent = 50000000n * 1000n;
    result[month] = {transactionCount:txs.length, revenue:money(revenue), originalExpense:money(expense),
      recognizedDifference:money(recognizedDifference), attributedDifference:current[month] ?? 0,
      adjustment:money(adjustment), correctionOffset:money(offset), rent:money(rent),
      correctedExpense:money(expense + adjustment - offset + rent),
      operatingProfit:money(revenue - expense - adjustment + offset - rent)};
  }
  const removedTotal = data.normalized.reduce((a,n) => a + units(n.before.difference_amount),0n);
  const cancelledTotal = data.cancelledDifferences.reduce((a,n) => a + units(n.before.amount),0n);
  const feeTotal = data.feeLines.reduce((a,l) => a + units(l.fee),0n);
  const cardGross = data.septemberCardPrincipal.sales.reduce((a,s) => a + units(s.amount),0n);
  const cardPrincipal = data.septemberCardPrincipal.depositLines.reduce((a,l) => a + units(l.gross),0n);
  return {months:result,currentAttribution:current,removedAttribution,
    card:{removedTotal:money(removedTotal),cancelledTotal:money(cancelledTotal),
      septemberFee:money(feeTotal),remainingFeeBeyondCancelled:money(feeTotal-removedTotal),
      septemberGross:money(cardGross),septemberDepositPrincipal:money(cardPrincipal),
      independentlyCalculatedSeptemberFee:money(cardGross-cardPrincipal),
      augustProfitChangeFromCard:removedAttribution['2026-08']},
    payrollCost:data.payroll.actual_paid_total+data.payroll.insurance_remittance_total+data.payroll.advance_total+data.payroll.company+data.payroll.employee};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(calculate(),null,2));
