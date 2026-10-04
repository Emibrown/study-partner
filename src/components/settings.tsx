"use client";

import { useState, type FormEvent } from "react";
import * as Switch from "@radix-ui/react-switch";
import { Check, Save } from "lucide-react";
import { useDemo } from "@/components/demo-provider";
import { Button, PageHeading } from "@/components/ui";
import { useHydrated } from "./use-hydrated";

export function Settings() {
  const hydrated = useHydrated();
  const { preferences, setPreferences, user } = useDemo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(preferences);
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/me/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error("Save failed");
      setPreferences(draft);
      setSaved(true);
    } catch {
      setError("Preferences could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="Your preferences"
        description="A study space that feels a little more like you."
      />
      <form
        className="settings-form"
        onSubmit={save}
        onChange={() => setSaved(false)}
      >
        <fieldset disabled={!hydrated} className="contents">
          <section className="settings-section">
            <div>
              <h2>Your profile</h2>
              <p>Your personal corner of the workspace.</p>
            </div>
            <div className="settings-fields">
              <div className="profile-display">
                <span className="avatar large">
                  {user?.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{user?.name}</strong>
                  <span>{user?.email}</span>
                </div>
              </div>
              <p>Signed in with Google</p>
            </div>
          </section>
          <section className="settings-section">
            <div>
              <h2>Study preferences</h2>
              <p>Start with what works for you.</p>
            </div>
            <div className="settings-fields">
              <div>
                <label htmlFor="study-goal">My study goal</label>
                <select
                  id="study-goal"
                  value={draft.goal}
                  onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                >
                  {[
                    "Understand my notes",
                    "Prepare for an exam",
                    "Build a study habit",
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="form-two-columns">
                <div>
                  <label htmlFor="duration">Session length</label>
                  <select
                    id="duration"
                    value={draft.duration}
                    onChange={(e) =>
                      setDraft({ ...draft, duration: e.target.value })
                    }
                  >
                    {["10 minutes", "20 minutes", "30 minutes"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="study-mode">Preferred mode</label>
                <select
                  id="study-mode"
                  value={draft.mode}
                  onChange={(e) => setDraft({ ...draft, mode: e.target.value })}
                >
                  {[
                    "Explain it back",
                    "Practice questions",
                    "Talk it through",
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <Toggle
                id="reminders"
                title="Study reminders"
                description="No notifications are scheduled yet."
                checked={draft.reminders}
                onChange={(checked) => {
                  setDraft({ ...draft, reminders: checked });
                  setSaved(false);
                }}
              />
            </div>
          </section>
          <section className="settings-section">
            <div>
              <h2>Voice preferences</h2>
              <p>Find a comfortable rhythm.</p>
            </div>
            <div className="settings-fields">
              <div className="form-two-columns">
                <div>
                  <label htmlFor="voice-style">Partner style</label>
                  <select
                    id="voice-style"
                    value={draft.voice}
                    onChange={(e) =>
                      setDraft({ ...draft, voice: e.target.value })
                    }
                  >
                    {[
                      "Warm & encouraging",
                      "Calm & thoughtful",
                      "Direct & focused",
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="pace">Speaking pace</label>
                  <select
                    id="pace"
                    value={draft.pace}
                    onChange={(e) =>
                      setDraft({ ...draft, pace: e.target.value })
                    }
                  >
                    {["Slower", "Natural", "Faster"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              <Toggle
                id="captions"
                title="Show conversation transcript"
                description="Show live captions and saved voice transcripts."
                checked={draft.captions}
                onChange={(checked) => {
                  setDraft({ ...draft, captions: checked });
                  setSaved(false);
                }}
              />
            </div>
          </section>
          <div className="settings-save">
            <span role="status">
              {saved ? (
                <>
                  <Check size={15} />
                  Preferences saved.
                </>
              ) : (
                "Preferences are saved to your account."
              )}
            </span>
            <Button type="submit" disabled={busy}>
              <Save size={16} />
              Save preferences
            </Button>
          </div>
        </fieldset>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function Toggle({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div>
        <label htmlFor={id}>{title}</label>
        <p>{description}</p>
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="switch"
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
    </div>
  );
}
