import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  return record(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
}
// CAS snapshot belongs to the intent. Only a generated outgoing payload stamp is
// ignored, so a lost HTTP response can replay the same user operation.
export function writerRequestId(operation: string, args: Record<string, unknown>, event: Record<string, unknown>, actorId: number) {
  const normalized = structuredClone(args);
  if (record(normalized.p_payload)) delete normalized.p_payload.updated_at;
  const hex = createHash("sha256").update(JSON.stringify(sorted({ operation, arguments: normalized, event, actor: actorId }))).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function inventoryWriterRpc(client: SupabaseClient, operation: string, args: Record<string, unknown>, actorId: number, input?: unknown, options: { retryTransport?: boolean } = {}) {
  const event = record(input) ? { ...input } : {};
  const supplied = event.requestId ?? args.p_request_id;
  delete event.requestId;
  const requestId = supplied === undefined ? writerRequestId(operation, args, event, actorId) : supplied;
  if (!Number.isSafeInteger(actorId) || actorId < 1 || typeof requestId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(requestId)) {
    return { data: null, error: { code: "22023", message: "INVENTORY_WRITER_INVALID_REQUEST" } };
  }
  // Missing effectiveAt/proof is deliberately preserved as missing evidence.
  const rpcArgs = { p_request_id: requestId, p_operation: operation, p_arguments: args, p_event: event, p_actor_user_id: actorId };
  let result = await client.rpc("inventory_writer_apply_v1", rpcArgs);
  if (options.retryTransport !== false && result.error?.code && ["08000", "08006", "PGRST000"].includes(result.error.code)) result = await client.rpc("inventory_writer_apply_v1", rpcArgs);
  return result;
}
