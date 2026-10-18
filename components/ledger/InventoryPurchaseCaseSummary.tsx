"use client";

import type { PurchaseCase } from "@/lib/inventory/purchase-cases";
import type { InventoryProjectionIssue } from "./InventoryProjectionResolution";
import styles from "./InventoryPurchaseCaseSummary.module.css";
import { purchaseCaseDisplay } from "@/lib/inventory/purchase-case-display";
import { Fragment } from "react";
import InventoryPurchaseCaseDetails from "./InventoryPurchaseCaseDetails";

export default function InventoryPurchaseCaseSummary({ issue, vi }: {
  issue: InventoryProjectionIssue & Partial<PurchaseCase>; vi: boolean;
}) {
  const name = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
  const root = issue.rootInventoryLogId;
  const display = purchaseCaseDisplay(issue, vi);
  return <div className={styles.summary} data-testid={`inventory-purchase-case-${root ?? issue.inventoryLogId}`}>
    <div className={styles.heading}><strong>{name}</strong></div>
    <div className={styles.supplier}>{issue.businessDate || "—"} · {display.candidate?.newSupplier || issue.supplier || (vi?"Chưa xác định":"미확정")}</div>
    <div className={styles.reason}><span className={styles.badge}>{display.reason}</span></div>
    <div className={styles.changes} data-testid="purchase-case-changes">{display.lines.map(line => <div key={line}>
      {display.changes.filter(change => line.includes(change.text)).map((change, index) => {
        // Wrap the existing display text only; values and change detection stay in purchaseCaseDisplay.
        const emphasisStart = change.kind === "amount" ? change.text.lastIndexOf(" (")
          : change.kind === "supplier" ? change.text.indexOf(" → ") + 3 : change.text.length;
        return <Fragment key={change.kind}>{index > 0 ? " · " : null}<span className={styles.changeValue}>
          {change.text.slice(0, emphasisStart)}<strong className={change.kind === "amount" ? styles.amountDelta : styles.changedSupplier}>{change.text.slice(emphasisStart)}</strong>
        </span></Fragment>;
      })}
    </div>)}{display.explanation ? <div className={styles.explanation}>{display.explanation}</div> : null}</div>
    <InventoryPurchaseCaseDetails issue={issue} vi={vi} />
  </div>;
}
