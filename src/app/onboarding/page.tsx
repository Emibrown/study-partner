import { Onboarding } from "@/components/auth";
import { requireViewer } from "@/lib/auth/session";
import { safeReturnPath } from "@/lib/auth/return-path";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeReturnPath((await searchParams).next);
  const viewer = await requireViewer(next, true);
  return <Onboarding returnTo={viewer.onboarded ? next : "/library"} />;
}
