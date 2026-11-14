import { reservationsApi, type ReservationContext } from "@/lib/reservations/server-api";
export const dynamic = "force-dynamic";
export const POST = (req: Request, context: ReservationContext) => reservationsApi(req, context, "reprocess");
