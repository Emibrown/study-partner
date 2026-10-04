import { Voice } from "@/components/study/voice-workspace";
import { requireViewer } from "@/lib/auth/session";
export default async function Page() {
  await requireViewer("/voice");
  return <Voice />;
}
