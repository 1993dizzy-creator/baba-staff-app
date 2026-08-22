import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import LedgerSubNav from "@/components/LedgerSubNav";
import { requireRole } from "@/lib/auth/server-auth";
import { LEDGER_MANAGER_ROLES } from "@/lib/ledger/authorization";

export const dynamic = "force-dynamic";

export default async function LedgerLayout({ children }: { children: ReactNode }) {
  const auth = await requireRole(LEDGER_MANAGER_ROLES);
  if (!auth.ok) redirect(auth.status === 401 ? "/login" : "/admin");
  return (
    <>
      <LedgerSubNav />
      {children}
    </>
  );
}
