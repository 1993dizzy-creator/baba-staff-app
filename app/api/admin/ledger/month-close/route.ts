import { buildMonthCloseSnapshot, snapshotHash, validCloseMonth } from "@/lib/ledger/month-close";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const month = new URL(request.url).searchParams.get("month");
  if (!validCloseMonth(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);

  try {
    const [{ data: closure, error: closureError }, { data: preflight, error: preflightError },
      { data: earlierReopened, error: earlierError }] = await Promise.all([
      supabaseServer.from("ledger_month_closures")
        .select("id,month,status,revision,closed_at,closed_by,reopened_at,reopened_by,reopen_reason,preflight_snapshot,summary_snapshot,snapshot_hash,warning_snapshot")
        .eq("month", `${month}-01`).maybeSingle(),
      supabaseServer.rpc("ledger_close_preflight_v1", { p_month: `${month}-01`, p_actor_user_id: auth.actor.id }),
      supabaseServer.from("ledger_month_closures").select("id")
        .lt("month", `${month}-01`).eq("status", "reopened").limit(1),
    ]);
    if (closureError || preflightError || earlierError) throw closureError ?? preflightError ?? earlierError;
    const checkedPreflight = earlierReopened?.length
      ? { ...preflight, canClose: false,
        blockers: [...(preflight?.blockers ?? []), { code: "EARLIER_MONTH_REOPENED" }] }
      : preflight;

    const currentSummary = await buildMonthCloseSnapshot(month);
    const currentSnapshotHash = snapshotHash(currentSummary);
    if (closure?.status === "closed") {
      return ledgerJson({ ok: true, month, state: "closed", closure,
        currentRecalculation: currentSummary, currentHash: currentSnapshotHash,
        snapshotDrift: currentSnapshotHash !== closure.snapshot_hash });
    }
    if (closure?.status === "reopened") {
      return ledgerJson({ ok: true, month, state: "reopened",
        closure: { id: closure.id, revision: closure.revision, reopenedAt: closure.reopened_at,
          reopenedBy: closure.reopened_by, reopenReason: closure.reopen_reason,
          previousSnapshotHash: closure.snapshot_hash },
        previousClosure: { closedAt: closure.closed_at, closedBy: closure.closed_by,
          summarySnapshot: closure.summary_snapshot, snapshotHash: closure.snapshot_hash },
        preflight: checkedPreflight, blockers: checkedPreflight?.blockers, warnings: checkedPreflight?.warnings,
        currentSummary, currentSnapshotHash, canClose: checkedPreflight?.canClose === true });
    }
    return ledgerJson({ ok: true, month, state: "open", preflight: checkedPreflight,
      summary: currentSummary, snapshotHash: currentSnapshotHash });
  } catch (error) {
    console.error("[LEDGER_MONTH_CLOSE_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "MONTH_CLOSE_LOAD_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as
    { action?: unknown; month?: unknown; reason?: unknown; expectedPreflightHash?: unknown } | null;
  if (!body || !validCloseMonth(body.month)) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  if (body.action !== undefined && body.action !== "close" && body.action !== "reopen") {
    return ledgerJson({ ok: false, code: "INVALID_ACTION" }, 400);
  }

  if (body.action === "reopen") {
    if (typeof body.reason !== "string" || !body.reason.trim()) {
      return ledgerJson({ ok: false, code: "REASON_REQUIRED" }, 400);
    }
    try {
      const { data, error } = await supabaseServer.rpc("ledger_reopen_month_v1", {
        p_month: `${body.month}-01`, p_reason: body.reason.trim(), p_actor_user_id: auth.actor.id,
      });
      if (error) throw error;
      const result = data as Record<string, unknown>;
      if (result.status === "reopened") return ledgerJson({ ok: true, result }, 200);
      const status = String(result.status);
      const httpStatus = status === "forbidden" ? 403 : status === "reason_required" ? 400
        : ["not_closed", "already_reopened", "later_month_closed"].includes(status) ? 409 : 400;
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, httpStatus);
    } catch (error) {
      console.error("[LEDGER_MONTH_REOPEN_POST_FAILED]", error);
      return ledgerJson({ ok: false, code: "MONTH_REOPEN_FAILED" }, 500);
    }
  }

  if (typeof body.expectedPreflightHash !== "string") {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }
  try {
    const { data: preflight, error: preflightError } = await supabaseServer.rpc("ledger_close_preflight_v1", {
      p_month: `${body.month}-01`, p_actor_user_id: auth.actor.id,
    });
    if (preflightError) throw preflightError;
    const check = preflight as Record<string, unknown>;
    if (check.preflightHash !== body.expectedPreflightHash) {
      return ledgerJson({ ok: false, code: "LEDGER_CLOSE_PREFLIGHT_STALE" }, 409);
    }
    if (!check.canClose) return ledgerJson({ ok: false, code: "MONTH_CLOSE_BLOCKED", blockers: check.blockers }, 409);
    const summary = await buildMonthCloseSnapshot(body.month);
    const hash = snapshotHash(summary);
    const { data, error } = await supabaseServer.rpc("ledger_close_month_v1", {
      p_month: `${body.month}-01`, p_expected_preflight_hash: body.expectedPreflightHash,
      p_preflight_snapshot: check, p_summary_snapshot: summary,
      p_snapshot_hash: hash, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as Record<string, unknown>;
    if (result.status !== "closed") {
      return ledgerJson({ ok: false, code: result.code ?? String(result.status).toUpperCase(), result },
        result.status === "preflight_stale" || result.status === "already_closed" || result.status === "blocked" ? 409 : 400);
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_MONTH_CLOSE_POST_FAILED]", error);
    return ledgerJson({ ok: false, code: "MONTH_CLOSE_FAILED" }, 500);
  }
}
