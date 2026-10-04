import { Settings } from "@/components/settings";
import { requireViewer } from "@/lib/auth/session";
export default async function Page() {
  await requireViewer("/settings");
  return <Settings />;
}
