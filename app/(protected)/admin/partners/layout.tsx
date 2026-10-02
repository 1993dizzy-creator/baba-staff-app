import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import LedgerSubNav from "@/components/LedgerSubNav";
import { requireRole } from "@/lib/auth/server-auth";
import { PARTNER_MANAGER_ROLES } from "@/lib/partners/policy";

export const dynamic = "force-dynamic";

// Partner and candidate detail pages belong to 가게 장부 > 장부설정 > 거래처.
export default async function PartnersLayout({ children }: { children: ReactNode }) {
  const auth = await requireRole(PARTNER_MANAGER_ROLES);
  if (!auth.ok) redirect(auth.status === 401 ? "/login" : "/admin");
  return <><LedgerSubNav />{children}</>;
}
