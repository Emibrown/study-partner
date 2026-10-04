import { handleVoice } from "@/lib/voice/server";
export const runtime = "nodejs";
export const maxDuration = 300;
export function POST(request: Request) {
  return handleVoice(request, ["llm", "chat", "completions"]);
}
