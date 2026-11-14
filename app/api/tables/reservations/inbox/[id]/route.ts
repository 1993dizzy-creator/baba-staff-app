import { reservationsApi, type ReservationContext } from "@/lib/reservations/server-api";
export const dynamic = "force-dynamic";
export const GET = (req: Request, context: ReservationContext) => reservationsApi(req, context, "inboxDetail");
