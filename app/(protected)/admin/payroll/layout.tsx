import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import PayrollSubNav from "@/components/PayrollSubNav";
import { requireRole } from "@/lib/auth/server-auth";

export const dynamic = "force-dynamic";

export default async function PayrollLayout({ children }: { children: ReactNode }) {
  const auth = await requireRole(["owner", "master"]);

  if (!auth.ok) {
    redirect(auth.status === 401 ? "/login" : "/admin");
  }

  return (
    <>
      <PayrollSubNav />
      {children}
    </>
  );
}
