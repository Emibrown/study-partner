"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  GraduationCap,
  Layers,
  Sparkles,
} from "lucide-react";
import { useDemo } from "@/components/demo-provider";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { safeReturnPath } from "@/lib/auth/return-path";
import { useHydrated } from "./use-hydrated";

const steps = [
  {
    title: "What brings you here?",
    description: "Let's make room for the way you want to learn.",
    field: "goal" as const,
    options: [
      {
        name: "Understand my notes",
        detail: "Make the difficult parts feel a little clearer.",
        icon: BookOpen,
      },
      {
        name: "Prepare for an exam",
        detail: "Build confidence one question at a time.",
        icon: GraduationCap,
      },
      {
        name: "Build a study habit",
        detail: "A little learning, more often.",
        icon: Sparkles,
      },
    ],
  },
  {
    title: "How do you like to learn?",
    description: "There's no single right way. You can always switch.",
    field: "mode" as const,
    options: [
      {
        name: "Explain it back",
        detail: "Find understanding in your own words.",
        icon: BookOpen,
      },
      {
        name: "Practice questions",
        detail: "Learn through questions and feedback.",
        icon: Layers,
      },
      {
        name: "Talk it through",
        detail: "Think out loud with a study partner.",
        icon: AudioLines,
      },
    ],
  },
];
export function Onboarding({ returnTo = "/" }: { returnTo?: string }) {
  const hydrated = useHydrated();
  const { preferences, setPreferences } = useDemo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(preferences);
  const [step, setStep] = useState(0);
  const current = steps[step];
  async function next() {
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/me/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error("Save failed");
      setPreferences(draft);
      window.location.assign(safeReturnPath(returnTo));
    } catch {
      setError("Your preferences couldn't be saved. Please try again.");
      setBusy(false);
    }
  }
  return (
    <main id="main-content" className="onboarding-page">
      <div
        className="onboarding-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={step + 1}
        aria-label={`Step ${step + 1} of ${steps.length}`}
      >
        {steps.map((_, i) => (
          <span key={i} className={i <= step ? "complete" : ""} />
        ))}
      </div>
      <span className="eyebrow">
        LET&apos;S GET TO KNOW YOUR STUDY STYLE · {step + 1} / {steps.length}
      </span>
      <h1>{current.title}</h1>
      <p>{current.description}</p>
      <div
        className="onboarding-options"
        role="radiogroup"
        aria-label={current.title}
      >
        {current.options.map(({ name, detail, icon: Icon }) => (
          <label
            key={name}
            className={cn(
              "onboarding-option",
              draft[current.field] === name && "selected",
            )}
          >
            <input
              className="sr-only"
              type="radio"
              name={current.field}
              checked={draft[current.field] === name}
              onChange={() => setDraft({ ...draft, [current.field]: name })}
            />
            <span className="feature-icon green">
              <Icon size={22} />
            </span>
            <span>
              <strong>{name}</strong>
              <small>{detail}</small>
            </span>
            <span className="selection-check">
              {draft[current.field] === name && <Check size={16} />}
            </span>
          </label>
        ))}
      </div>
      <div className="onboarding-actions">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep(step - 1)}
        >
          <ArrowLeft size={16} />
          Back
        </Button>
        <Button onClick={next} disabled={!hydrated || busy}>
          {step === steps.length - 1 ? "Make it my space" : "Continue"}
          <ArrowRight size={17} />
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
