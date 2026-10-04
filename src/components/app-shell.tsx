"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUpRight,
  AudioLines,
  BookOpen,
  ChevronDown,
  GraduationCap,
  House,
  Layers,
  LogIn,
  Menu,
  Plus,
  Settings,
  Sparkles,
  Timer,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useDemo } from "@/components/demo-provider";
import { AddNotesDialog } from "@/components/materials/add-notes-dialog";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth/client";

const navItems = [
  { href: "/", label: "Overview", icon: House },
  { href: "/library", label: "My library", icon: BookOpen },
  { href: "/practice", label: "Practice", icon: Layers },
  { href: "/voice", label: "Voice role-play", icon: AudioLines },
  { href: "/history", label: "Study history", icon: Timer },
];

function Brand({ linked = true }: { linked?: boolean }) {
  const content = (
    <>
      <span className="brand-mark">
        <BookOpen size={22} strokeWidth={1.8} />
      </span>
      <span>
        study<span className="font-normal">partner</span>
        <span className="brand-period">.</span>
      </span>
    </>
  );
  return linked ? (
    <Link href="/" className="brand" aria-label="Study Partner home">
      {content}
    </Link>
  ) : (
    <span className="brand" aria-label="Study Partner">
      {content}
    </span>
  );
}

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  const { materials } = useDemo();
  return (
    <nav
      aria-label={mobile ? "Mobile navigation" : "Main navigation"}
      className="nav-items"
    >
      {navItems.map(({ href, label, icon: Icon }) => {
        const link = (
          <Link
            href={href}
            className={cn(
              "nav-link",
              (href === "/" ? pathname === href : pathname.startsWith(href)) &&
                "active",
            )}
            aria-current={pathname === href ? "page" : undefined}
          >
            <Icon size={19} strokeWidth={1.8} />
            <span>{label}</span>
            {href === "/library" && (
              <span className="nav-count">
                {String(materials.length).padStart(2, "0")}
              </span>
            )}
          </Link>
        );
        return mobile ? (
          <Dialog.Close key={href} asChild>
            {link}
          </Dialog.Close>
        ) : (
          <div key={href}>{link}</div>
        );
      })}
    </nav>
  );
}

export function AppShell({
  children,
  onboarded,
}: {
  children: ReactNode;
  onboarded: boolean;
}) {
  const { setAddNotesOpen, user } = useDemo();
  const pathname = usePathname();
  const authPage = ["/sign-in", "/onboarding", "/auth/continue"].includes(
    pathname,
  );
  if (authPage)
    return (
      <>
        <header className="auth-header">
          <Brand linked={pathname !== "/onboarding" || onboarded} />
          {(pathname !== "/onboarding" || onboarded) && (
            <Link href="/" className="text-link">
              Back to study space <ArrowUpRight size={15} />
            </Link>
          )}
        </header>
        {children}
        <AddNotesDialog />
      </>
    );
  const current =
    navItems.find((item) => item.href === pathname)?.label ||
    (pathname.startsWith("/study")
      ? "Study workspace"
      : pathname.startsWith("/recap")
        ? "Session recap"
        : "Settings");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">YOUR STUDY SPACE</div>
        <Navigation />
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="tiny-star">
              <Sparkles size={18} />
            </span>
            <p>
              A little progress,
              <br />
              <strong>every single day.</strong>
            </p>
            <span className="small-muted">You&apos;ve got this.</span>
          </div>
          <Link
            href="/settings"
            className={cn("nav-link", pathname === "/settings" && "active")}
          >
            <Settings size={19} />
            Settings
          </Link>
          <div className="sidebar-footer">
            <span className="status-dot" />
            Personal workspace
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <Dialog.Root>
              <Dialog.Trigger asChild>
                <button
                  className="icon-button mobile-menu"
                  aria-label="Open navigation"
                >
                  <Menu size={21} />
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="dialog-overlay" />
                <Dialog.Content className="mobile-nav-panel">
                  <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Go to a page in your study space.
                  </Dialog.Description>
                  <div className="flex items-center justify-between">
                    <Brand />
                    <Dialog.Close asChild>
                      <button
                        className="icon-button"
                        aria-label="Close navigation"
                      >
                        <X size={20} />
                      </button>
                    </Dialog.Close>
                  </div>
                  <Navigation mobile />
                  <Dialog.Close asChild>
                    <Link href="/settings" className="nav-link">
                      <Settings size={18} />
                      Settings
                    </Link>
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <span className="breadcrumb">
              My workspace <span>/</span> <strong>{current}</strong>
            </span>
          </div>
          <div className="topbar-actions">
            <span className="demo-label">
              <span className="status-dot" />
              Private workspace
            </span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="profile-trigger"
                  aria-label="Open profile menu"
                >
                  <span className="avatar">
                    {user?.name
                      .split(/\s+/)
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </span>
                  <ChevronDown size={14} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown-content"
                  align="end"
                  sideOffset={10}
                >
                  <DropdownMenu.Label className="dropdown-label">
                    {user?.name}
                    <br />
                    {user?.email}
                  </DropdownMenu.Label>
                  <DropdownMenu.Item asChild>
                    <Link href="/settings">
                      <Settings size={16} />
                      Preferences
                    </Link>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item asChild>
                    <Link href="/onboarding">
                      <GraduationCap size={16} />
                      Study goals
                    </Link>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="dropdown-separator" />
                  <DropdownMenu.Item
                    onSelect={async () => {
                      const result = await authClient.signOut();
                      // Discard all temporary study state and cached authenticated pages.
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                      if (!result.error) window.location.assign("/sign-in");
                      else window.alert("Sign-out failed. Please try again.");
                    }}
                  >
                    <LogIn size={16} />
                    Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        <main id="main-content" className="content">
          {children}
        </main>
        <footer className="app-footer">
          <span>Small steps. Deeper understanding.</span>
          <Button variant="ghost" onClick={() => setAddNotesOpen(true)}>
            <Plus size={14} />
            Add study material
          </Button>
        </footer>
      </div>
      <AddNotesDialog />
    </div>
  );
}
