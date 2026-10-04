"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, Trash2 } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { AiGate } from "./ai-gate";
import { Conversation } from "./conversation";
import type { MaterialDetail } from "@/lib/materials/types";
import { useDemo } from "@/components/demo-provider";
import { Button, ButtonLink, PageHeading } from "@/components/ui";
import { PdfPreview } from "@/components/materials/pdf-preview";
export function StudyWorkspace({ material }: { material: MaterialDetail }) {
  const router = useRouter();
  const { refreshMaterials } = useDemo();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/materials/${material.id}`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new Error("This material couldn't be deleted. Please try again.");
      const result = await response.json();
      await refreshMaterials();
      setConfirm(false);
      router.replace(
        result.cleanupPending ? "/library?cleanup=pending" : "/library",
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Deletion failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ButtonLink href="/library" variant="ghost">
        Back to library
      </ButtonLink>
      <PageHeading
        eyebrow={material.kind}
        title={material.title}
        action={
          <div className="flex flex-wrap gap-2">
            <a
              className="button button-secondary"
              href={`/api/materials/${material.id}/content`}
              download
            >
              <Download size={17} />
              Download material
            </a>
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={17} />
              Delete
            </Button>
          </div>
        }
      />
      <Tabs.Root defaultValue="conversation" className="study-split-tabs">
        <Tabs.List className="study-mobile-tabs" aria-label="Workspace view">
          <Tabs.Trigger value="material">Material</Tabs.Trigger>
          <Tabs.Trigger value="conversation">Conversation</Tabs.Trigger>
        </Tabs.List>
        <div className="material-reader-layout ai-workspace-layout">
          <Tabs.Content
            value="material"
            forceMount
            aria-label="Material content"
            className="material-reader study-pane"
          >
            {material.kind === "Notes" ? (
              <div className="notes-content">{material.notes}</div>
            ) : (
              <PdfPreview id={material.id} />
            )}
          </Tabs.Content>
          <Tabs.Content value="conversation" forceMount className="study-pane">
            <AiGate materialId={material.id}>
              <Conversation materialId={material.id} />
            </AiGate>
          </Tabs.Content>
        </div>
      </Tabs.Root>
      <Dialog.Root
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>Delete this material?</Dialog.Title>
            <Dialog.Description>
              This removes it from your library and schedules its file for
              permanent deletion, including its AI conversations, practice
              results, and learning memory. This cannot be undone.
            </Dialog.Description>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                variant="secondary"
                onClick={() => setConfirm(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button onClick={() => void remove()} disabled={busy}>
                <Trash2 size={16} />
                {busy ? "Deleting..." : "Delete material"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
