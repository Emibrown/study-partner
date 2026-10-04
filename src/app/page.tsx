import { Overview } from "@/components/overview";
import { requireViewer } from "@/lib/auth/session";
export default async function Page() {
  await requireViewer("/");
  return <Overview />;
}
