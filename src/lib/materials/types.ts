export type Material = {
  id: string;
  title: string;
  kind: "PDF" | "Notes";
  byteSize: number;
  createdAt: string;
};
export type MaterialDetail = Material & { notes: string | null };
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_NOTE_CHARS = 100_000;
