import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import {
  buildInventoryBootstrapEnrichmentEvent,
  buildInventoryBootstrapInitialItems,
  createInventoryBootstrapTiming,
  fetchInventoryBootstrapBase,
  fetchInventoryBootstrapEnrichment,
} from "@/lib/inventory/bootstrap-server";
import { canToggleInventoryItemActiveStatus } from "@/lib/inventory/items-server";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const encoder = new TextEncoder();

const encodeEvent = (event: Record<string, unknown>) =>
  encoder.encode(`${JSON.stringify(event)}\n`);

const errorResponse = (
  timing: ReturnType<typeof createInventoryBootstrapTiming>,
  error: string,
  status: number
) =>
  NextResponse.json(
    { ok: false, error, code: error },
    { status, headers: { "Server-Timing": timing.header() } }
  );

export async function GET(request: Request) {
  const timing = createInventoryBootstrapTiming();

  try {
    const authStartedAt = performance.now();
    let auth;
    try {
      auth = await getAuthenticatedActor();
    } finally {
      timing.record("auth", performance.now() - authStartedAt);
    }
    if (!auth.ok) return errorResponse(timing, auth.code, auth.status);

    const includeInactive =
      new URL(request.url).searchParams.get("includeInactive") === "true";
    if (
      includeInactive &&
      !canToggleInventoryItemActiveStatus(auth.actor.role)
    ) {
      return errorResponse(
        timing,
        "inventory_item_inactive_list_forbidden",
        403
      );
    }

    const base = await fetchInventoryBootstrapBase({
      supabase: supabaseAdmin,
      includeInactive,
      timing,
    });
    timing.record("first_chunk", timing.snapshot().total);
    const initialItems = buildInventoryBootstrapInitialItems(base);
    let cancelled = request.signal.aborted;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          cancelled = true;
          try {
            controller.close();
          } catch {
            // The client may have already cancelled its reader.
          }
        };
        request.signal.addEventListener("abort", abort, { once: true });

        if (cancelled) {
          abort();
          return;
        }

        controller.enqueue(encodeEvent({ type: "items", items: initialItems }));

        void fetchInventoryBootstrapEnrichment({
          supabase: supabaseAdmin,
          base,
          timing,
        })
          .then((enrichment) => {
            if (cancelled) return;
            controller.enqueue(
              encodeEvent({
                type: "enrichment",
                ...buildInventoryBootstrapEnrichmentEvent(enrichment),
              })
            );
            controller.enqueue(
              encodeEvent({ type: "complete", timing: timing.snapshot() })
            );
            controller.close();
          })
          .catch((error) => {
            console.error("[INVENTORY_BOOTSTRAP_STREAM_ENRICHMENT_ERROR]", error);
            if (cancelled) return;
            controller.enqueue(
              encodeEvent({
                type: "error",
                stage: "enrichment",
                code: "inventory_bootstrap_enrichment_failed",
                timing: timing.snapshot(),
              })
            );
            controller.close();
          })
          .finally(() => {
            request.signal.removeEventListener("abort", abort);
          });
      },
      cancel() {
        cancelled = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Server-Timing": timing.header(["auth", "items", "first_chunk"]),
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[INVENTORY_BOOTSTRAP_STREAM_GET_ERROR]", error);
    return errorResponse(timing, "inventory_bootstrap_load_failed", 500);
  }
}
