export const voiceRoles = ["Classmate", "Mock Examiner"] as const;
export type VoiceRole = (typeof voiceRoles)[number];
export type VoiceEntry = {
  role: "user" | "agent";
  message: string;
  time: number;
};
export type VoiceSession = {
  diagnosticReference?: string;
  id: string;
  materialId: string;
  title: string;
  role: VoiceRole;
  status: "starting" | "active" | "ending" | "ended" | "failed" | "uncertain";
  createdAt: string;
  expiresAt: string;
  connectedAt: string | null;
  transcript: VoiceEntry[];
  transcriptFinal: boolean;
  interrupted: boolean;
};
export type VoiceStart = {
  session: VoiceSession;
  conversationToken: string;
  capability: string;
  alias: string;
  speed: number;
};
