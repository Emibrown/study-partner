"use client";
import { Plus } from "lucide-react";
import { useDemo } from "./demo-provider";
import {
  Button,
  ButtonLink,
  EmptyState,
  LoadingState,
  PageHeading,
} from "./ui";
import { MaterialCard } from "./materials/material-card";
import { useEffect, useState } from "react";
import { aiRequest } from "./study/ai-client";
import type { Session } from "@/lib/ai/types";
export function Overview() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  useEffect(() => {
    let alive = true;
    void aiRequest<{ sessions: Session[] }>("/api/study-sessions")
      .then((data) => {
        if (alive) setSessions(data.sessions.slice(0, 3));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const {
    user,
    materials,
    loading,
    materialsError,
    refreshMaterials,
    setAddNotesOpen,
  } = useDemo();
  return (
    <>
      <PageHeading
        eyebrow="YOUR STUDY SPACE"
        title={`Welcome, ${user?.name.split(" ")[0] || "learner"}`}
        description="Your materials, at your own pace."
        action={
          <Button onClick={() => setAddNotesOpen(true)}>
            <Plus size={17} />
            Add material
          </Button>
        }
      />
      <section className="materials-section">
        <div className="section-heading">
          <h2>Your study materials</h2>
          <ButtonLink href="/library" variant="ghost">
            View library
          </ButtonLink>
        </div>
        {loading ? (
          <LoadingState />
        ) : materialsError ? (
          <EmptyState title="Library unavailable" description={materialsError}>
            <Button onClick={() => void refreshMaterials()}>Try again</Button>
          </EmptyState>
        ) : materials.length ? (
          <div className="material-grid">
            {materials.slice(0, 3).map((material) => (
              <MaterialCard key={material.id} material={material} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Start with your own materials"
            description="Add a PDF or paste your notes to begin your collection."
          >
            <Button onClick={() => setAddNotesOpen(true)}>
              <Plus size={16} />
              Add your first material
            </Button>
          </EmptyState>
        )}
      </section>
      <section className="materials-section">
        <div className="section-heading">
          <h2>Study sessions</h2>
        </div>
        {sessions?.length ? (
          <div className="ai-history">
            {sessions.map((s) => (
              <ButtonLink
                variant="secondary"
                key={s.id}
                href={
                  s.kind === "voice" ? `/voice?session=${s.id}` : s.kind === "practice"
                    ? `/recap/${s.id}`
                    : `/study/${s.material_id}?session=${s.id}`
                }
              >
                {s.title} · {s.mode}
              </ButtonLink>
            ))}
          </div>
        ) : (
          <p className="page-description">
            {sessions
              ? "No sessions yet. Open a material to start studying."
              : "Open history to view your study sessions."}
          </p>
        )}
        <ButtonLink href="/history" variant="ghost">
          View history
        </ButtonLink>
      </section>
    </>
  );
}
