// Request guards for the push device routes (01-B).
// CSRF: a state-changing request must come from this app's own origin. The browser sends Origin on
// every POST (page or service worker); when it is absent, Sec-Fetch-Site must say same-origin.
// A JSON content type is also required, so a cross-site HTML form can never reach these routes.

export function isSameOriginRequest(request: Request) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      const expected = host ?? new URL(request.url).host;
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host === expected;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function isJsonRequest(request: Request) {
  return /^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "");
}
