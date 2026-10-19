"use client";

import Link from "next/link";
import { purchaseRepairError } from "@/lib/inventory/purchase-repair-contract";
import { inventoryLedgerEntryHref, type InventoryDailySyncResult } from "@/lib/inventory/daily-sync-result";

// Shortcut buttons inside the daily sync summary banner: one per original receipt that
// needs an admin, opening the exact Ledger entry (or the purchase correction editor).
export default function InventoryDailySyncResults({ results, businessDate, lang }: {
  results: InventoryDailySyncResult[]; businessDate: string; lang: "ko" | "vi";
}) {
  const vi = lang === "vi";
  const actions = results.flatMap(item => item.targets
    .filter(target => target.status === "review_required")
    .map(target => ({ item, target })))
    .filter(({ target }, index, all) => all.findIndex(row => row.target.purchaseLogId === target.purchaseLogId) === index);
  if (!actions.length) return null;
  return <div data-testid="inventory-daily-sync-actions" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
    {actions.map(({ item, target }) => {
      const name = (vi ? item.currentItemNameVi || item.currentItemName : item.currentItemName || item.currentItemNameVi) || `#${item.itemId}`;
      const quantityReview = target.code === "QUANTITY_CORRECTION_REQUIRED";
      const href = quantityReview ? `/inventory?itemId=${item.itemId}&mode=edit` : inventoryLedgerEntryHref(target, businessDate);
      const action = quantityReview ? (vi ? "Mở điều chỉnh nhập mua" : "구매입고 정정") : (vi ? "Xem trong sổ" : "장부에서 확인");
      return <Link key={target.purchaseLogId} href={href} prefetch={false}
        data-purchase-log-id={target.purchaseLogId}
        title={`${name} · #${target.purchaseLogId} · ${purchaseRepairError(target.code, vi)}`}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%", minHeight: 32, padding: "6px 10px",
          borderRadius: 8, border: "1px solid #d97706", background: "#fff", color: "#92400e", fontSize: 12, fontWeight: 800,
          textDecoration: "none", boxSizing: "border-box" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{name}</span>
        <span style={{ flexShrink: 0 }}>· {action} →</span>
      </Link>;
    })}
  </div>;
}
