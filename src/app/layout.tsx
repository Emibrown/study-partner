import type { Metadata } from "next";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "./globals.css";
import { DemoProvider } from "@/components/demo-provider";
import { AppShell } from "@/components/app-shell";
import { getViewer } from "@/lib/auth/session";
import { SessionBoundary } from "@/components/session-boundary";

export const metadata: Metadata = {
  title: "Study Partner | A little more understanding",
  description:
    "Your personal space to explore notes, practice ideas, and learn at your own pace.",
};
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const viewer = await getViewer();
  const content = (
    <DemoProvider
      key={viewer?.user.id ?? "anonymous"}
      user={viewer?.user}
      initialPreferences={viewer?.preferences}
    >
      <AppShell onboarded={viewer?.onboarded ?? false}>{children}</AppShell>
    </DemoProvider>
  );
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        {viewer ? (
          <SessionBoundary userId={viewer.user.id}>{content}</SessionBoundary>
        ) : (
          content
        )}
      </body>
    </html>
  );
}
export const dynamic = "force-dynamic";
