import { reservationsApi } from "@/lib/reservations/server-api";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => reservationsApi(req, undefined, "list");
export const POST = (req: Request) => reservationsApi(req, undefined, "create");
