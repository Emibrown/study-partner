import "server-only";
import { readAuthConfig } from "./config";
import { getAuthServices } from "./server";
import { readProfile } from "./preferences";

export async function readViewer(headers: Headers, disableRefresh = false) {
  if (!readAuthConfig()) return null;
  const { auth, readOnlyAuth, pool } = getAuthServices();
  const session = await (disableRefresh ? readOnlyAuth : auth).api.getSession({
    headers,
    query: { disableRefresh },
  });
  if (!session || !session.user.emailVerified) return null;
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    },
    ...(await readProfile(pool, session.user.id)),
  };
}
