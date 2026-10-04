import { handleVoice } from "@/lib/voice/server";
export const runtime = "nodejs";
export function POST(request: Request) {
  return handleVoice(request, ["webhook"]);
}
