import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import PartnerSubNav from "@/components/PartnerSubNav";
import { requireRole } from "@/lib/auth/server-auth";
import { PARTNER_MANAGER_ROLES } from "@/lib/partners/policy";

export const dynamic = "force-dynamic";

export default async function PartnersLayout({ children }: { children: ReactNode }) {
  const auth = await requireRole(PARTNER_MANAGER_ROLES);
  if (!auth.ok) redirect(auth.status === 401 ? "/login" : "/admin");
  return <><PartnerSubNav />{children}</>;
}
