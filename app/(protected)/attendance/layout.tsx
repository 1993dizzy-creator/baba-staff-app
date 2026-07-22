import AttendanceSessionGuard from "@/components/AttendanceSessionGuard";

export default function AttendanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AttendanceSessionGuard>{children}</AttendanceSessionGuard>;
}
