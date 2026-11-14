// Persist adapter: Zalo webhook -> public.reservation_inbox_ingest_v1 (service_role RPC).
// The RPC deduplicates on (chat id, message id) and returns stored | duplicate; any error or
// unexpected answer throws ZaloInboxPersistError so the webhook answers 503 (not ACKed).
// Error details from the database are never logged or returned: only a short code.
import {
  ZaloInboxPersistError,
  type ZaloInboxEntry,
  type ZaloInboxPersist,
  type ZaloInboxPersistResult,
} from "../zalo/webhook-poc.ts";

export type InboxRpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

export const INBOX_INGEST_RPC = "reservation_inbox_ingest_v1";

export function createZaloInboxPersist(getClient: () => Promise<InboxRpcClient>): ZaloInboxPersist {
  return async (entry: ZaloInboxEntry): Promise<ZaloInboxPersistResult> => {
    let client: InboxRpcClient;
    try {
      client = await getClient();
    } catch {
      throw new ZaloInboxPersistError("client_unavailable");
    }
    let response: { data: unknown; error: { code?: string } | null };
    try {
      response = await client.rpc(INBOX_INGEST_RPC, { p_entry: entry });
    } catch {
      throw new ZaloInboxPersistError("rpc_unreachable");
    }
    if (response.error) {
      const code = typeof response.error.code === "string" && /^[A-Z0-9]{5}$/.test(response.error.code)
        ? `pg_${response.error.code}` : "rpc_error";
      throw new ZaloInboxPersistError(code);
    }
    const data = response.data as Record<string, unknown> | null;
    if (!data || (data.status !== "stored" && data.status !== "duplicate")) {
      const status = typeof data?.status === "string" ? data.status : "no_data";
      throw new ZaloInboxPersistError(`rpc_${status}`);
    }
    const inboxId = Number(data.inboxId);
    if (!Number.isSafeInteger(inboxId) || inboxId < 1) throw new ZaloInboxPersistError("rpc_bad_id");
    return {
      status: data.status,
      inboxId,
      deliveryCount: Number(data.deliveryCount) || 1,
      payloadMismatch: data.payloadMismatch === true,
    };
  };
}
