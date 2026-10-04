"use client";
import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { safeReturnPath } from "@/lib/auth/return-path";

export function SessionBoundary({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const { data, isPending, error } = authClient.useSession();
  const pathname = usePathname();
  const changed = !isPending && !error && data?.user.id !== userId;
  useEffect(() => {
    if (changed)
      window.location.replace(
        `/sign-in?next=${encodeURIComponent(safeReturnPath(pathname))}`,
      );
  }, [changed, pathname]);
  if (changed)
    return (
      <div role="status" className="empty-state">
        Updating your session...
      </div>
    );
  return children;
}
