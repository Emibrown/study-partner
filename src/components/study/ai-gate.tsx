"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { RotateCcw, Sparkles } from "lucide-react";
import type { Preparation } from "@/lib/ai/types";
import { Button } from "@/components/ui";
import { aiRequest } from "./ai-client";

export function AiGate({
  materialId,
  children,
}: {
  materialId: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<Preparation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"consent" | "reset" | null>(null);
  const [version, setVersion] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const container = useRef<HTMLDivElement>(null);
  function openDialog(value: "consent" | "reset") {
    opener.current = document.activeElement as HTMLElement;
    setDialog(value);
  }
  const url = `/api/materials/${materialId}/ai`;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await aiRequest<Preparation>(url);
        if (!alive) return;
        setState(result);
        setError("");
        if (["preparing", "indexing"].includes(result.status))
          timer = setTimeout(load, 3000);
      } catch (e) {
        if (alive)
          setError(e instanceof Error ? e.message : "Status unavailable.");
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, version]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      if (dialog === "reset") {
        await aiRequest(url, "DELETE");
        setState({ status: "unprepared", configured: true });
      } else
        setState(await aiRequest<Preparation>(url, "POST", { consent: true }));
      setDialog(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ai-gate" ref={container} tabIndex={-1}>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!state && (
        <>
          <p role="status">Checking AI study availability...</p>
          {error && (
            <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
          )}
        </>
      )}
      {state?.status === "ready" ? (
        <>
          <div className="ai-context-actions">
            <span className="small-muted">
              AI may make mistakes. Check your material.
            </span>
            <Button variant="ghost" onClick={() => openDialog("reset")}>
              <RotateCcw size={15} />
              Reset AI data
            </Button>
          </div>
          <div key={version}>{children}</div>
        </>
      ) : (
        state && (
          <section className="ai-preparation" aria-label="AI preparation">
            <Sparkles size={24} />
            <h2>Your study partner</h2>
            {!state.configured ? (
              <p>
                AI study is not configured yet. Your material is available to
                read.
              </p>
            ) : state.status === "unprepared" ? (
              <>
                <p>
                  Study this material with explanations, questions, and
                  feedback.
                </p>
                <Button onClick={() => openDialog("consent")}>
                  Enable AI study
                </Button>
              </>
            ) : ["preparing", "indexing"].includes(state.status) ? (
              <>
                <p role="status">Preparing your material for AI study...</p>
                <p className="small-muted">
                  Indexing can take a few minutes. You can leave and return.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => setVersion((v) => v + 1)}
                >
                  Check status
                </Button>
              </>
            ) : (
              <>
                <p>
                  Preparation could not be completed. Reset the AI context
                  before retrying; your original material is retained.
                </p>
                <Button onClick={() => openDialog("reset")}>
                  Reset and retry
                </Button>
              </>
            )}
          </section>
        )
      )}
      <Dialog.Root
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (opener.current?.isConnected) opener.current.focus();
              else container.current?.focus();
            }}
          >
            <Dialog.Title>
              {dialog === "reset"
                ? "Reset AI study data?"
                : "Use AI with this material?"}
            </Dialog.Title>
            <Dialog.Description>
              {dialog === "reset"
                ? "This permanently removes this material's conversations, practice results, and learning memory. Remote deletion is queued for retry if unavailable. The original material stays in your library."
                : "This material and your study messages will be processed by Backboard and its model providers, including OpenRouter. Learning memory stays scoped to this material. Only continue with content you are permitted to share. You can reset AI study data later."}
            </Dialog.Description>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void confirm()}>
                {busy
                  ? "Please wait..."
                  : dialog === "reset"
                    ? "Reset AI study data"
                    : "Agree and prepare"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
