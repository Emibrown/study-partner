import { Library } from "@/components/materials/library";
import { requireViewer } from "@/lib/auth/session";
export default async function Page() {
  await requireViewer("/library");
  return <Library />;
}
