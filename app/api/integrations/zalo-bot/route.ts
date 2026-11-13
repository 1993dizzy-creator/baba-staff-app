import { handleZaloWebhook } from "@/lib/zalo/webhook-poc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Zalo Bot webhook — receive-only PoC. Authenticates X-Bot-Api-Secret-Token against
// ZALO_BOT_WEBHOOK_SECRET (fail-closed when unset) and logs safe metadata only.
// No DB write, no reply, no persistence: not an operational reservation intake.
export async function POST(req: Request) {
  return handleZaloWebhook(req, {
    ZALO_BOT_WEBHOOK_SECRET: process.env.ZALO_BOT_WEBHOOK_SECRET,
    ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS,
    ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID: process.env.ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID,
  });
}
