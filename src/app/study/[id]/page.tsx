import { StudyWorkspace } from "@/components/study/study-workspace";
import { requireViewer } from "@/lib/auth/session";
import { getAuthServices } from "@/lib/auth/server";
import { getMaterial, MaterialError } from "@/lib/materials/repository";
import { notFound } from "next/navigation";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await requireViewer(`/study/${id}`);
  const material = await getMaterial(
    getAuthServices().pool,
    viewer.user.id,
    id,
  ).catch((error) => {
    if (error instanceof MaterialError && error.status === 404) notFound();
    throw error;
  });
  return <StudyWorkspace key={id} material={material.detail} />;
}
