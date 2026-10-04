"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "@/components/ui";

export function PdfPreview({ id }: { id: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    void (async () => {
      try {
        const pdf = await import("pdfjs-dist");
        if (cancelled) return;
        pdf.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const task = pdf.getDocument({
          url: `/api/materials/${id}/content`,
          disableAutoFetch: true,
          disableStream: true,
        });
        destroy = () => {
          void task.destroy();
        };
        const result = await task.promise;
        if (!cancelled) setDocument(result);
      } catch {
        if (!cancelled)
          setError(
            "This PDF cannot be previewed. Download it to open it in your PDF reader.",
          );
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [id]);
  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    let cancel: (() => void) | undefined;
    void (async () => {
      try {
        const item = await document.getPage(page);
        if (cancelled || !canvas.current) return;
        const viewport = item.getViewport({ scale: 1.5 });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        const task = item.render({ canvas: canvas.current, viewport });
        cancel = () => task.cancel();
        await task.promise;
      } catch {
        if (!cancelled)
          setError("This page cannot be previewed. Try downloading the PDF.");
      }
    })();
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, [document, page]);
  return (
    <section aria-label="PDF preview">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          {!document && <p role="status">Loading PDF...</p>}
          <div className="pdf-toolbar">
            <IconButton
              label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={18} />
            </IconButton>
            <span aria-live="polite">
              {document ? `Page ${page} of ${document.numPages}` : "Loading"}
            </span>
            <IconButton
              label="Next page"
              disabled={!document || page >= document.numPages}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={18} />
            </IconButton>
          </div>
          <canvas
            ref={canvas}
            className="pdf-canvas"
            aria-label={`PDF page ${page}. Use Download material for the original accessible document.`}
          />
        </>
      )}
    </section>
  );
}
