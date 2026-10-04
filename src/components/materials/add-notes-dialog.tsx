"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Check, FileText, LoaderCircle, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useDemo } from "@/components/demo-provider";
import { Button } from "@/components/ui";

export function AddNotesDialog() {
  const { addNotesOpen, setAddNotesOpen } = useDemo();
  const opener = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root
      open={addNotesOpen}
      onOpenChange={(open) => {
        if (!busy) setAddNotesOpen(open);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onOpenAutoFocus={() => {
            opener.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
        >
          <Dialog.Close asChild>
            <button
              className="icon-button dialog-close"
              aria-label="Close add notes"
              disabled={busy}
            >
              <X size={20} />
            </button>
          </Dialog.Close>
          <div className="feature-icon green">
            <FileText size={23} />
          </div>
          <Dialog.Title>Add study material</Dialog.Title>
          <Dialog.Description>
            A fresh page for your next breakthrough.
          </Dialog.Description>
          <AddNotesForm
            busy={busy}
            setBusy={setBusy}
            onClose={() => setAddNotesOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AddNotesForm({
  onClose,
  busy,
  setBusy,
}: {
  onClose: () => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const router = useRouter();
  const { refreshMaterials, pdfUploadsAvailable } = useDemo();
  const [tab, setTab] = useState("file");
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || (tab === "file" ? !fileName : !notes.trim())) {
      setError("Add a title and choose a file or paste your notes.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/materials", {
        method: "POST",
        headers:
          tab === "file"
            ? {
                "Content-Type": "application/pdf",
                "X-Material-Title": encodeURIComponent(title.trim()),
              }
            : { "Content-Type": "application/json" },
        body: tab === "file" ? file : JSON.stringify({ title, notes }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      await refreshMaterials();
      onClose();
      router.push(`/study/${result.id}`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Your material could not be saved. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <div>
        <label htmlFor="material-title">Material title</label>
        <input
          id="material-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Week one lecture notes"
          maxLength={120}
          disabled={busy}
        />
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (!busy) {
            setTab(value);
            setError("");
          }
        }}
      >
        <Tabs.List className="segmented" aria-label="Material source">
          <Tabs.Trigger value="file" disabled={busy}>
            Choose a file
          </Tabs.Trigger>
          <Tabs.Trigger value="text" disabled={busy}>
            Paste notes
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="file" className="mt-4">
          <label className="file-drop" htmlFor="material-file">
            <UploadCloud size={29} />
            <strong>{fileName || "Choose your study notes"}</strong>
            <span>PDF · Up to 20 MiB</span>
            <input
              id="material-file"
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              disabled={busy || !pdfUploadsAvailable}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (
                  !file.name.toLowerCase().endsWith(".pdf") ||
                  file.size > 20 * 1024 * 1024
                ) {
                  setError("Choose a PDF smaller than 20 MB.");
                  setFileName("");
                  setFile(null);
                  return;
                }
                setError("");
                setFileName(file.name);
                setFile(file);
                if (!title) setTitle(file.name.replace(/\.pdf$/i, ""));
              }}
            />
          </label>
          {!pdfUploadsAvailable && (
            <p className="field-help">
              PDF uploads are not configured yet. You can paste notes instead.
            </p>
          )}
        </Tabs.Content>
        <Tabs.Content value="text" className="mt-4">
          <label htmlFor="pasted-notes">Your notes</label>
          <textarea
            id="pasted-notes"
            rows={6}
            maxLength={100000}
            disabled={busy}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Paste the topic you'd like to study..."
          />
        </Tabs.Content>
      </Tabs.Root>
      <p className="field-help">
        Materials are private to your account. AI study tools are not available
        yet.
      </p>
      {error && (
        <p ref={errorRef} tabIndex={-1} className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || (tab === "file" && !pdfUploadsAvailable)}
        >
          {busy ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : (
            <Check size={16} />
          )}
          {busy ? "Saving..." : "Save material"}
        </Button>
      </div>
    </form>
  );
}
