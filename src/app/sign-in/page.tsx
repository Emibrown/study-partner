import { AuthForm } from "@/components/auth-form";
import { readAuthConfig } from "@/lib/auth/config";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <AuthForm
      next={typeof params.next === "string" ? params.next : undefined}
      initialError={typeof params.error === "string" ? params.error : undefined}
      configured={Boolean(readAuthConfig())}
    />
  );
}
