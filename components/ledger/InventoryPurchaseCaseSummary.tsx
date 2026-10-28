"use client";

import type { PurchaseCase } from "@/lib/inventory/purchase-cases";
import type { InventoryProjectionIssue } from "./InventoryProjectionResolution";
import styles from "./InventoryPurchaseCaseSummary.module.css";
import { purchaseCaseDisplay } from "@/lib/inventory/purchase-case-display";
import { Fragment } from "react";
import InventoryPurchaseCaseDetails from "./InventoryPurchaseCaseDetails";

const valueText = (text: string) => text.slice(text.indexOf(": ") + 2);

// Compact banner row: item + reason on one line, then date · supplier (or "before → after")
// · other changes on one wrapping line. Values and change detection stay in
// purchaseCaseDisplay; the history and audit details stay folded below.
export default function InventoryPurchaseCaseSummary({ issue, vi }: {
  issue: InventoryProjectionIssue & Partial<PurchaseCase>; vi: boolean;
}) {
  const name = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
  const root = issue.rootInventoryLogId;
  const display = purchaseCaseDisplay(issue, vi);
  const supplierChange = display.changes.find(change => change.kind === "supplier");
  const others = display.changes.filter(change => change.kind !== "supplier");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(issue.businessDate ?? "") ? issue.businessDate.slice(5).replace("-", "/") : issue.businessDate || "—";
  const supplierValue = supplierChange ? valueText(supplierChange.text) : null;
  const arrow = supplierValue ? supplierValue.indexOf(" → ") : -1;
  return <div className={styles.summary} data-testid={`inventory-purchase-case-${root ?? issue.inventoryLogId}`}>
    <div className={styles.heading}><strong>{name}</strong><span className={styles.badge}>{display.reason}</span></div>
    <div className={styles.meta} data-testid="purchase-case-changes">
      <time dateTime={issue.businessDate}>{date}</time>{" · "}
      {supplierValue && arrow >= 0
        ? <span className={styles.changeValue} data-testid="purchase-case-supplier-change">{supplierValue.slice(0, arrow)} → <strong className={styles.changedSupplier}>{supplierValue.slice(arrow + 3)}</strong></span>
        : <span>{display.candidate?.newSupplier || issue.supplier || (vi ? "Chưa xác định" : "미확정")}</span>}
      {others.map(change => {
        // Wrap the existing display text only: emphasise the amount delta.
        const emphasisStart = change.kind === "amount" ? change.text.lastIndexOf(" (") : change.text.length;
        return <Fragment key={change.kind}>{" · "}<span className={styles.changeValue}>
          {change.text.slice(0, emphasisStart)}<strong className={styles.amountDelta}>{change.text.slice(emphasisStart)}</strong>
        </span></Fragment>;
      })}
    </div>
    {display.explanation ? <div className={styles.explanation}>{display.explanation}</div> : null}
    <InventoryPurchaseCaseDetails issue={issue} vi={vi} />
  </div>;
}
