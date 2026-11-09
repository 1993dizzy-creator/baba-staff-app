import "server-only";
import { createHash } from "node:crypto";

// Kept apart from the collector so read paths never import the CUKCUK login/transport.
const DEFAULT_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";

export function openOrdersBranchId() {
  return (process.env.CUKCUK_BRANCH_ID?.trim() || DEFAULT_BRANCH_ID).toLowerCase();
}

/** Company+branch scope derived without a CUKCUK login. */
export function openOrdersScope() {
  const domain = process.env.CUKCUK_DOMAIN?.trim();
  if (!domain) throw new Error("OPEN_ORDERS_SCOPE_UNAVAILABLE");
  return `${createHash("sha256").update(domain.toLowerCase()).digest("hex")}:${openOrdersBranchId()}`;
}
