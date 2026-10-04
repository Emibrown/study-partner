import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readViewer } from "./viewer";
import { safeReturnPath } from "./return-path";

export const getViewer = cache(async () => {
  return readViewer(await headers());
});
export async function requireViewer(returnTo = "/", allowOnboarding = false) {
  const viewer = await getViewer();
  const next = safeReturnPath(returnTo);
  if (!viewer) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  if (!viewer.onboarded && !allowOnboarding)
    redirect(`/onboarding?next=${encodeURIComponent(next)}`);
  return viewer;
}
