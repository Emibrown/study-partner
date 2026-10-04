export const voiceErrorMessages = {
  microphone_permission:
    "Microphone permission was denied. Allow access before starting a new call.",
  transport:
    "The voice transport disconnected. Open the saved session before starting again.",
  provider_authentication:
    "The voice provider rejected authentication. Check the server configuration.",
  model_timeout:
    "The voice model response timed out. Open the saved session before retrying.",
  generation_failure:
    "The voice model could not finish its response. Open the saved session before retrying.",
  session_expired: "This voice session has ended or expired.",
} as const;
export type VoiceErrorCode = keyof typeof voiceErrorMessages;
export function classifyVoiceError(message: string): VoiceErrorCode {
  if (/permission|notallowed|denied.*microphone/i.test(message))
    return "microphone_permission";
  if (/expired|session.*ended/i.test(message)) return "session_expired";
  if (/unauthoriz|authentication|\b401\b|\b403\b/i.test(message))
    return "provider_authentication";
  if (/timeout|timed out/i.test(message)) return "model_timeout";
  if (/llm|model|generation|\b1002\b/i.test(message))
    return "generation_failure";
  return "transport";
}
