export const modes = ["Explain", "Quiz", "Explain It Back"] as const;
export type StudyMode = (typeof modes)[number];
export type Preparation = {
  status:
    "unprepared" | "preparing" | "indexing" | "ready" | "failed" | "uncertain";
  configured: boolean;
};
export type StudyMessage = {
  id: string;
  role: "user" | "assistant" | "mode";
  content: string;
  created_at: string;
};
export type Operation = { id: string; status: string; output: string };
export type Session = {
  id: string;
  material_id: string;
  title: string;
  kind: "study" | "practice" | "voice";
  mode: StudyMode | "Practice" | "Classmate" | "Mock Examiner";
  voice_status?: string;
  created_at: string;
  updated_at: string;
  messages: StudyMessage[];
  operation?: Operation;
  questions?: PracticeQuestion[];
};
export type PracticeQuestion = {
  position: number;
  question: string;
  choices: string[];
  answer: number | null;
  correct?: number;
  explanation?: string;
  topic?: string;
};
