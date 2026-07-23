"use client";

import { handleSessionUnauthorized } from "@/lib/auth/client-session";

export async function fetchSalesApi(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const response = await fetch(input, init);
  if (response.status === 401) handleSessionUnauthorized(response);
  return response;
}
