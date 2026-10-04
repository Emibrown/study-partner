import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/session";
import { safeReturnPath } from "@/lib/auth/return-path";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeReturnPath((await searchParams).next);
  const viewer = await requireViewer(next, true);
  redirect(
    viewer.onboarded ? next : `/onboarding?next=${encodeURIComponent(next)}`,
  );
}
