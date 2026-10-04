"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { BookOpen, LoaderCircle } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { safeReturnPath } from "@/lib/auth/return-path";
import { Button } from "./ui";
import { useHydrated } from "./use-hydrated";

function errorMessage(code?: string) {
  if (code === "access_denied")
    return "Google sign-in was cancelled. Please try again when you're ready.";
  if (code === "TOO_MANY_REQUESTS")
    return "Too many attempts. Wait a minute, then try again.";
  return "Google sign-in couldn't be completed. Please try again.";
}
export function AuthForm({
  next = "/",
  initialError,
  configured,
}: {
  next?: string;
  initialError?: string;
  configured: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  const [error, setError] = useState(
    initialError ? errorMessage(initialError) : "",
  );
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function google() {
    setBusy(true);
    setError("");
    const returnTo = encodeURIComponent(safeReturnPath(next));
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: `/auth/continue?next=${returnTo}`,
        newUserCallbackURL: `/auth/continue?next=${returnTo}`,
        errorCallbackURL: `/sign-in?next=${returnTo}`,
      });
      if (result.error) {
        setError(
          errorMessage(
            result.error.status === 429
              ? "TOO_MANY_REQUESTS"
              : result.error.code,
          ),
        );
        setBusy(false);
      }
    } catch {
      setError(errorMessage());
      setBusy(false);
    }
  }
  return (
    <main id="main-content" className="auth-page">
      <div className="auth-intro">
        <span className="feature-icon green">
          <BookOpen size={26} />
        </span>
        <span className="eyebrow">YOUR CURIOSITY. YOUR PACE.</span>
        <h1>
          Your space
          <br /> to learn.
        </h1>
        <p>
          Your own space to ask questions, connect ideas,
          <br />
          and make learning your own.
        </p>
        <div className="auth-quote">
          <span>ONE SMALL STEP</span>
          <blockquote>
            You don&apos;t have to understand
            <br />
            everything all at once.
          </blockquote>
        </div>
      </div>
      <section className="auth-form">
        <h2>Welcome to Study Partner</h2>
        <p className="small-muted">
          Sign in with Google to your personal study space.
        </p>
        {!configured && (
          <p className="auth-notice" role="status">
            Sign-in is not available yet. The service configuration needs to be
            completed.
          </p>
        )}
        {error && (
          <p
            ref={errorRef}
            tabIndex={-1}
            className="form-error auth-notice"
            role="alert"
          >
            {error}
          </p>
        )}
        <Button
          className="w-full mt-8"
          variant="secondary"
          disabled={!hydrated || busy || !configured}
          onClick={google}
          aria-busy={busy}
        >
          {busy ? (
            <LoaderCircle size={17} className="animate-spin" />
          ) : (
            <Image
              src="/images/google-logo.png"
              alt=""
              aria-hidden="true"
              width={18}
              height={18}
              className="shrink-0 object-contain"
              unoptimized
            />
          )}
          Continue with Google
        </Button>
        {busy && (
          <p className="field-help" role="status">
            Opening Google...
          </p>
        )}
      </section>
    </main>
  );
}
