"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, ButtonLink, EmptyState, PageHeading } from "@/components/ui";
import { aiRequest } from "./ai-client";
import type { Session } from "@/lib/ai/types";
export function History() {
  const [sessions, setSessions] = useState<
    (Session & { answered: number; score: number })[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    void aiRequest<{
      sessions: (Session & { answered: number; score: number })[];
    }>("/api/study-sessions")
      .then((data) => {
        if (alive) {
          setSessions(data.sessions);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [version]);
  return (
    <>
      <PageHeading eyebrow="YOUR LEARNING JOURNEY" title="Study history" />
      {loading && <p role="status">Loading study history...</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      )}
      {!loading && !error && !sessions.length && (
        <EmptyState
          title="No study sessions yet"
          description="Your conversations and practice results will appear here."
        >
          <ButtonLink href="/library">Open library</ButtonLink>
        </EmptyState>
      )}
      <div className="ai-history">
        {sessions.map((s) => (
          <Link
            className="ai-history-item"
            key={s.id}
            href={
              s.kind === "voice"
                ? `/voice?session=${s.id}`
                : s.kind === "practice"
                  ? `/recap/${s.id}`
                  : `/study/${s.material_id}?session=${s.id}`
            }
          >
            <div>
              <h2>{s.title}</h2>
              <p>
                {s.kind === "voice"
                  ? `${s.mode}: ${s.voice_status ?? "saved"}`
                  : s.kind === "practice"
                    ? s.answered === 5
                      ? `Practice: ${s.score} / 5 correct`
                      : `Practice: ${s.answered} / 5 answered`
                    : s.mode}
              </p>
            </div>
            <time dateTime={s.updated_at}>
              {new Date(s.updated_at).toLocaleString()}
            </time>
          </Link>
        ))}
      </div>
    </>
  );
}
