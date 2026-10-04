"use client";
import Link from "next/link";
import { ArrowUpRight, FileText, NotebookPen } from "lucide-react";
import type { Material } from "@/lib/materials/types";
export function MaterialCard({ material }: { material: Material }) {
  return (
    <Link href={`/study/${material.id}`} className="material-card group">
      <div className="flex items-start justify-between">
        <span
          className={`file-icon ${material.kind === "PDF" ? "coral" : "green"}`}
        >
          {material.kind === "PDF" ? (
            <FileText size={23} />
          ) : (
            <NotebookPen size={23} />
          )}
        </span>
        <span className="material-type">{material.kind}</span>
      </div>
      <h3>{material.title}</h3>
      <p>
        {new Date(material.createdAt).toLocaleDateString("en-GB")}
        {material.kind === "PDF"
          ? ` · ${(material.byteSize / 1024).toFixed(0)} KB`
          : ""}
      </p>
      <div className="flex items-center justify-between mt-5">
        <span>Open material</span>
        <ArrowUpRight size={16} />
      </div>
    </Link>
  );
}
