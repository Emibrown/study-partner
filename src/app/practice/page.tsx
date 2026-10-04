import { Practice } from "@/components/study/practice-panel";
import { requireViewer } from "@/lib/auth/session";
export default async function Page() {
  await requireViewer("/practice");
  return <Practice />;
}
