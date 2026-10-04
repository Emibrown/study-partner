"use client";

import { useSearchParams } from "next/navigation";
import * as Tabs from "@radix-ui/react-tabs";
import { Plus, Search } from "lucide-react";
import { useDemo } from "@/components/demo-provider";
import { Button, EmptyState, LoadingState, PageHeading } from "@/components/ui";
import { MaterialCard } from "./material-card";

export function Library() {
  const {
    materials,
    loading,
    materialsError,
    refreshMaterials,
    setAddNotesOpen,
  } = useDemo();
  const params = useSearchParams();
  const search = params.get("q") ?? "";
  const filter = ["pdf", "notes"].includes(params.get("type") ?? "")
    ? params.get("type")!
    : "all";
  function updateFilters(q: string, type: string) {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (type !== "all") next.set("type", type);
    window.history.replaceState(
      null,
      "",
      `/library${next.size ? `?${next}` : ""}`,
    );
  }
  const results = materials.filter(
    (m) =>
      m.title.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || m.kind.toLowerCase() === filter),
  );
  return (
    <>
      <PageHeading
        eyebrow="YOUR COLLECTION"
        title="My library"
        description="Everything you're curious about, all in one place."
        action={
          <Button onClick={() => setAddNotesOpen(true)}>
            <Plus size={17} />
            Add material
          </Button>
        }
      />
      {params.get("cleanup") === "pending" && (
        <p role="status" className="field-help">
          Material removed from your library. Remote file and AI cleanup is
          queued for retry.
        </p>
      )}
      <Tabs.Root
        value={filter}
        onValueChange={(value) => updateFilters(search, value)}
      >
        <div className="library-toolbar">
          <Tabs.List className="underline-tabs" aria-label="Filter materials">
            {["All materials", "PDF", "Notes"].map((tab) => (
              <Tabs.Trigger
                key={tab}
                value={tab === "All materials" ? "all" : tab.toLowerCase()}
              >
                {tab}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="Search materials"
              placeholder="Find a material..."
              value={search}
              onChange={(e) => updateFilters(e.target.value, filter)}
            />
          </div>
        </div>
        <Tabs.Content value={filter}>
          <p className="results-count" aria-live="polite">
            {results.length} {results.length === 1 ? "material" : "materials"}
          </p>
          {loading ? (
            <LoadingState />
          ) : materialsError ? (
            <EmptyState
              title="Library unavailable"
              description={materialsError}
            >
              <Button onClick={() => void refreshMaterials()}>Try again</Button>
            </EmptyState>
          ) : results.length ? (
            <div className="material-grid library-grid">
              {results.map((material) => (
                <MaterialCard key={material.id} material={material} />
              ))}
            </div>
          ) : (
            <EmptyState
              title={
                materials.length
                  ? "No matching materials"
                  : "Your library starts here"
              }
              description={
                materials.length
                  ? "Try another title or clear your filters."
                  : "Add your own PDF or paste your notes. No course or subject required."
              }
            >
              <Button
                variant="secondary"
                onClick={() => {
                  if (materials.length) updateFilters("", "all");
                  else setAddNotesOpen(true);
                }}
              >
                {materials.length ? "Clear filters" : "Add your first material"}
              </Button>
            </EmptyState>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}
