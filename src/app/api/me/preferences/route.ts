import { profileHandler } from "@/lib/auth/profile-handler";
export const runtime = "nodejs";
export const GET = (request: Request) => profileHandler(request);
export const PUT = (request: Request) => profileHandler(request);
