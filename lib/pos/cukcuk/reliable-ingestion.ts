import { randomUUID } from "node:crypto";
import { collectStableInvoices, CollectionError, type CollectedInvoice } from "./reliable-collection";

type JsonObject = Record<string, unknown>;
export type IngestWindow = { businessDate: string; collectionFrom: string; collectionTo: string; settingSource: string };
export type IngestDependencies = {
  rpc: (name: string, args: JsonObject) => Promise<JsonObject>;
  page: (page: number, limit: number, from: string) => Promise<unknown>;
  detail: (refId: string) => Promise<unknown>;
  encode: (invoice: CollectedInvoice, window: IngestWindow, observedAt: string) => JsonObject;
};

export async function runReliableIngestion(input: {
  scope: string; branchId: string; window: IngestWindow; limit?: number;
  runId?: string; ownerToken?: string;
}, dependencies: IngestDependencies): Promise<JsonObject> {
  const runId = input.runId ?? randomUUID(), ownerToken = input.ownerToken ?? randomUUID();
  if (input.window.settingSource === "error_fallback") throw new CollectionError("collection_window_unverified");
  const { window } = input;
  const claim = await dependencies.rpc("pos_ingest_claim", {
    p_run_id: runId, p_owner_token: ownerToken, p_scope: input.scope, p_branch_id: input.branchId,
    p_business_date: window.businessDate, p_from: window.collectionFrom, p_to: window.collectionTo,
  });
  if (claim.status === "committed") return claim.result as JsonObject;
  if (claim.status !== "collecting") return claim;
  let persistenceStarted = false;
  try {
    const limit = input.limit ?? 100;
    const observed = await collectStableInvoices({ branchId: input.branchId, from: window.collectionFrom, to: window.collectionTo, limit,
      page: page => dependencies.page(page, limit, window.collectionFrom), detail: dependencies.detail });
    const selected = observed.second.invoices.filter(item => {
      const time = Date.parse(String(item.invoice.RefDate ?? item.invoice.PostedDate));
      return time >= Date.parse(window.collectionFrom) && time < Date.parse(window.collectionTo);
    });
    const observedAt = new Date().toISOString();
    const snapshots = selected.map(item => dependencies.encode(item, window, observedAt));
    const manifest = {
      collectionComplete: true, providerSequenceVerified: false, automaticConfirmation: false,
      total: observed.first.total, enumeratedCount: observed.first.count, selectedCount: selected.length,
      firstHash: observed.first.hash, secondHash: observed.second.hash,
      firstAmount: observed.first.amount, secondAmount: observed.second.amount,
      firstPages: observed.first.pages, secondPages: observed.second.pages,
      // Persist evidence for every enumerated ID, including out-of-window rows.
      entries: observed.second.invoices.map(item => ({ refId: item.refId, hash: item.hash, amount: item.amount })),
    };
    persistenceStarted = true;
    // Identical request replay handles an ambiguous PostgREST response loss. SQL
    // rechecks owner + immutable payload hash before returning the first result.
    const args = { p_run_id: runId, p_owner_token: ownerToken, p_manifest: manifest, p_snapshots: snapshots };
    try { return await dependencies.rpc("pos_ingest_commit", args); }
    catch { return await dependencies.rpc("pos_ingest_commit", args); }
  } catch (error) {
    try { await dependencies.rpc("pos_ingest_fail", { p_run_id: runId, p_owner_token: ownerToken,
      p_code: error instanceof CollectionError ? error.code : persistenceStarted ? "persistence_failed" : "collection_failed" }); }
    catch { /* A DB outage leaves a lease, not a false completed cursor. */ }
    throw error instanceof CollectionError ? error : new CollectionError(persistenceStarted ? "persistence_failed" : "collection_failed");
  }
}

export async function fetchCollectionJson(url: string, init: RequestInit, timeoutMs = 15000): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new CollectionError("provider_http_failure");
    return await response.json();
  } catch (error) { throw error instanceof CollectionError ? error : new CollectionError("provider_timeout_or_response_failure"); }
}
