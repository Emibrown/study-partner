import "server-only";
import { z } from "zod";
export const DIAGNOSTIC_NOTES =
  "Fictional study note: A solar cart uses a panel to charge a battery. The battery stores energy and powers a small motor.";
export function diagnosticSelected(session: string, owner: string) {
  return (
    process.env.VOICE_DIAGNOSTIC_MODE === "deterministic" &&
    z.uuid().safeParse(process.env.VOICE_DIAGNOSTIC_SESSION_ID).success &&
    process.env.VOICE_DIAGNOSTIC_SESSION_ID === session &&
    Boolean(process.env.VOICE_DIAGNOSTIC_USER_ID) &&
    process.env.VOICE_DIAGNOSTIC_USER_ID === owner
  );
}
