import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { resolutionWritesEnabled } from "@/lib/sales/admin-resolution-server";
import { observePendingPos } from "@/lib/sales/pending-pos-recheck";

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["owner", "master", "manager"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });
  if (!resolutionWritesEnabled()) return NextResponse.json({ ok: false, error: "feature_disabled" }, { status: 503 });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const { data, error } = await supabaseServer.from("pos_sales_receipts").select("ref_id,source").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: "receipt_unavailable" }, { status: 503 });
  if (!data || data.source !== "cukcuk" || !data.ref_id) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  try { await observePendingPos(data.ref_id, "refresh"); return NextResponse.json({ ok: true }); }
  catch { return NextResponse.json({ ok: false, error: "pos_lookup_failed" }, { status: 502 }); }
}
