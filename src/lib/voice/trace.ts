import "server-only";
import { createHash } from "node:crypto";

export type VoiceTraceEvent =
  | "connected"
  | "provider_request"
  | "dispatched"
  | "first_token"
  | "completed"
  | "cancelled"
  | "failed"
  | "uncertain"
  | "stream_closed"
  | "disconnected"
  | "idle"
  | "diagnostic";
export const voiceReference = (id: string) =>
  createHash("sha256").update(`voice:${id}`).digest("hex").slice(0, 12);
export function voiceTrace(session: string, operation?: string) {
  const started = performance.now();
  return (event: VoiceTraceEvent) => {
    if (process.env.VOICE_TRACE !== "1") return;
    console.info(
      JSON.stringify({
        scope: "voice",
        reference: voiceReference(session),
        operation: operation ? voiceReference(operation) : undefined,
        event,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  };
}
