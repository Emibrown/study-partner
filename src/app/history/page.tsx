import { History } from "@/components/study/history";
import { requireViewer } from "@/lib/auth/session";
export default async function Page() {
  await requireViewer("/history");
  return <History />;
}
