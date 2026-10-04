import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:/.test(value)),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});
export type AuthConfig = z.infer<typeof schema>;
export function readAuthConfig(): AuthConfig | null {
  const result = schema.safeParse(process.env);
  if (!result.success) return null;
  const url = new URL(result.data.BETTER_AUTH_URL);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return null;
  if (
    process.env.NODE_ENV === "production" &&
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    return null;
  return { ...result.data, BETTER_AUTH_URL: url.origin };
}
