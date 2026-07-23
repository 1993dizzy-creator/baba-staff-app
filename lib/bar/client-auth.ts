"use client";

import { handleSessionUnauthorized } from "@/lib/auth/client-session";

export function fetchBarApi(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, init);
}

export async function handleBarApiUnauthorized(response: Response) {
  return handleSessionUnauthorized(response);
}
