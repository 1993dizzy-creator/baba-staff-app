import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { buildCukcukHeaders, CUKCUK_BASE_URL, buildReceiptRow, buildLineRow, buildPaymentRow,
  getDetailsFromInvoicePayload, getPaymentsFromInvoicePayload } from "@/lib/pos/cukcuk/sales-receipt-sync";
import { CollectionError, recoveryBusinessDates } from "./reliable-collection";
import { runReliableIngestion, fetchCollectionJson, type IngestWindow } from "./reliable-ingestion";

// Called only after the existing POS secret guard. No public resolution action:
// resolving an ambiguous observation requires the owner/master admin boundary.
export async function handleReliableSalesSync(req: Request, resolveWindow: (date: string) => Promise<IngestWindow>) {
  try {
    const body = await req.json().catch(() => ({}));
    const branchId = typeof body.branchId === "string" && body.branchId.trim() ? body.branchId.trim().toLowerCase() : "c39228ba-a452-4cf9-bf34-424ffb151fb8";
    if (body.businessDate !== undefined && typeof body.businessDate !== "string") throw new CollectionError("invalid_recovery_date");
    const explicitDate = body.businessDate?.trim() ?? "";
    if (explicitDate) recoveryBusinessDates(explicitDate, 1);
    const baseWindow = await resolveWindow(explicitDate);
    const requestedDate = baseWindow.businessDate;
    const dates = body.recover === true
      ? recoveryBusinessDates(requestedDate, body.recentDays ?? 7, body.gapDates ?? [])
      : recoveryBusinessDates(requestedDate, 1);
    if (typeof body.limit !== "undefined" && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100)) throw new CollectionError("invalid_page_limit");
    const login = await loginCukcuk();
    const scope = `${createHash("sha256").update(login.companyCode).digest("hex")}:${branchId}`;
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await supabaseServer.rpc(name, args);
      if (error) {
        const safeReasons = ["payment_snapshot_amount_mismatch", "paid_payment_snapshot_empty", "payment_external_id_missing",
          "duplicate_payment_external_id", "duplicate_payment_composite_identity", "ingest_lease_lost", "ingest_manifest_incomplete",
          "ingest_manifest_entries_invalid", "ingest_identity_scope_collision", "ingest_commit_payload_conflict"];
        throw new CollectionError(safeReasons.includes(error.message) ? error.message : /^[0-9A-Z]{5}$/.test(error.code ?? "")
          ? `persistence_sqlstate_${error.code.toLowerCase()}` : "persistence_failed");
      }
      return data as Record<string, unknown>;
    };
    if (body.inspect === true) return NextResponse.json({ ok: true, result: await rpc("pos_ingest_inspect", { p_scope: scope, p_since: dates[0] }) });
    const headers = buildCukcukHeaders(login.accessToken, login.companyCode);
    const results = [];
    // Each date commits independently. Failure stops the sweep; no overall cursor
    // can leap over a failed day. Explicit older gap dates survive the 7-day horizon.
    for (const date of dates) {
      const result = await runReliableIngestion({ scope, branchId, window: date === baseWindow.businessDate ? baseWindow : await resolveWindow(date), limit: body.limit }, {
        rpc,
        page: (page, limit, from) => fetchCollectionJson(`${CUKCUK_BASE_URL}/api/v1/sainvoices/paging`, {
          method: "POST", headers, body: JSON.stringify({ Page: page, Limit: limit, BranchId: branchId, LastSyncDate: from }),
        }),
        detail: refId => fetchCollectionJson(`${CUKCUK_BASE_URL}/api/v1/sainvoices/detail/${encodeURIComponent(refId)}`, { headers }),
        encode: (item, window, observedAt) => {
          const receipt = buildReceiptRow({ invoice: item.invoice, detailPayload: item.detail, businessDate: window.businessDate, syncedAt: observedAt });
          receipt.ref_id = item.refId; receipt.branch_id = branchId;
          const metadata = (raw: Record<string, unknown>) => Object.fromEntries(Object.entries(raw)
            .filter(([key]) => ["refid", "branchid", "refdate", "orderdate", "createddate", "modifieddate", "canceldate", "revision", "version", "sequence"]
              .includes(key.replace(/[_\s-]/g, "").toLowerCase())));
          return { contentHash: item.hash, receipt,
            sourceMetadata: { list: metadata(item.invoice), detail: metadata(item.detail), providerSequenceVerified: false },
            lines: getDetailsFromInvoicePayload(item.detail).map((detail, i) => buildLineRow({ receiptId: null,
              receiptRefId: item.refId, detail, businessDate: window.businessDate, refDate: receipt.ref_date,
              paymentStatus: receipt.payment_status, isCanceled: receipt.is_canceled, sortOrder: i + 1, syncedAt: observedAt })),
            payments: getPaymentsFromInvoicePayload(item.detail).map(payment => buildPaymentRow({ receiptId: null,
              receiptRefId: item.refId, payment, businessDate: window.businessDate, refDate: receipt.ref_date, syncedAt: observedAt })),
          };
        },
      });
      results.push(result);
      if (result.status === "busy") return NextResponse.json({ ok: false, code: "SYNC_ALREADY_RUNNING", results }, { status: 409 });
    }
    return NextResponse.json({ ok: true, businessDate: dates.at(-1), result: results.at(-1), recoveryResults: results,
      warning: "Provider ordering and physical movement times remain unverified; Shadow confirmation is disabled." });
  } catch (error) {
    return NextResponse.json({ ok: false, code: error instanceof CollectionError ? error.code : "reliable_collection_failed" }, { status: 502 });
  }
}
