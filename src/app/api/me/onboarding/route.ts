import { profileHandler } from "@/lib/auth/profile-handler";
export const runtime = "nodejs";
export const POST = (request: Request) => profileHandler(request, true);
