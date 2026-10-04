import { Practice } from "@/components/study/practice-panel";
import { requireViewer } from "@/lib/auth/session";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireViewer(`/recap/${id}`);
  return <Practice initialId={id} />;
}
