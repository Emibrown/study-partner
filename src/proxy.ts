import { NextResponse, type NextRequest } from "next/server";
import { readViewer } from "@/lib/auth/viewer";
import { safeReturnPath } from "@/lib/auth/return-path";

export async function proxy(request: NextRequest) {
  const onboarding = request.nextUrl.pathname === "/onboarding";
  const next = safeReturnPath(
    onboarding
      ? request.nextUrl.searchParams.get("next")
      : request.nextUrl.pathname,
  );
  // Only check access here; normal auth requests retain session renewal.
  const viewer = await readViewer(request.headers, true);
  const destination = !viewer
    ? "/sign-in"
    : !viewer.onboarded && !onboarding
      ? "/onboarding"
      : null;
  if (!destination) return NextResponse.next();
  const url = new URL(destination, request.url);
  url.searchParams.set("next", next);
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/",
    "/library",
    "/practice",
    "/voice",
    "/history",
    "/settings",
    "/study/:id",
    "/recap/:id",
    "/onboarding",
  ],
};
