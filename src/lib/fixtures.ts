export type Preferences = {
  goal: string;
  mode: string;
  duration: string;
  voice: string;
  pace: string;
  captions: boolean;
  reminders: boolean;
};
export const defaultPreferences: Preferences = {
  goal: "Understand my notes",
  mode: "Explain it back",
  duration: "20 minutes",
  voice: "Warm & encouraging",
  pace: "Natural",
  captions: true,
  reminders: false,
};
