import { GET as getInventoryLogs } from "../route";

// The rewrite and direct route share authentication, projection and ordering.
export async function GET(req: Request) {
  const url = new URL(req.url);
  url.searchParams.set("mode", "recent");
  return getInventoryLogs(new Request(url, req));
}
