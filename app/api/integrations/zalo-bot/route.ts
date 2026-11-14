import { handleZaloWebhook } from "@/lib/zalo/webhook-poc";
import { createZaloInboxPersist, type InboxRpcClient } from "@/lib/reservations/zalo-inbox-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Zalo Bot webhook. Authenticates X-Bot-Api-Secret-Token against ZALO_BOT_WEBHOOK_SECRET
// (fail-closed when unset) and logs safe metadata only. No reply is ever sent.
// ZALO_BOT_WEBHOOK_MODE unset/"observe": verified PoC behavior, nothing stored.
// ZALO_BOT_WEBHOOK_MODE="persist": stores the delivery in the reservation inbox before ACKing
// (requires the reservation inbox migration and a non-empty group allowlist). It never creates
// or confirms a reservation.
// The DB client is loaded lazily so observe mode keeps working without DB configuration.
const persistToInbox = createZaloInboxPersist(
  async () => (await import("@/lib/supabase/server")).supabaseServer as unknown as InboxRpcClient,
);

export async function POST(req: Request) {
  return handleZaloWebhook(
    req,
    {
      ZALO_BOT_WEBHOOK_SECRET: process.env.ZALO_BOT_WEBHOOK_SECRET,
      ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS,
      ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID: process.env.ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID,
      ZALO_BOT_WEBHOOK_MODE: process.env.ZALO_BOT_WEBHOOK_MODE,
    },
    undefined,
    persistToInbox,
  );
}
