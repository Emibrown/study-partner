"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { useDemo } from "@/components/demo-provider";
import { Button, ButtonLink, EmptyState, PageHeading } from "@/components/ui";
import type { Session } from "@/lib/ai/types";
import { AiGate } from "./ai-gate";
import { aiRequest, generate } from "./ai-client";

function PracticeAttempt({
  materialId,
  initialId,
}: {
  materialId: string;
  initialId?: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<number | null>(null);
  const requestKey = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const list = await aiRequest<{ sessions: Session[] }>(
          `/api/study-sessions?materialId=${materialId}`,
        );
        const recent =
          initialId ?? list.sessions.find((s) => s.kind === "practice")?.id;
        if (recent) {
          const result = await aiRequest<Session>(`/api/practice/${recent}`);
          if (alive) setSession(result);
        }
      } catch (e) {
        if (alive)
          setError(e instanceof Error ? e.message : "Practice unavailable.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [materialId, initialId]);
  const questions = session?.questions ?? [];
  const answered = questions.filter((q) => q.answer !== null).length;
  const complete = questions.length === 5 && answered === 5;
  const current = questions[feedback ?? answered];
  const active =
    busy ||
    Boolean(
      session?.operation &&
      ["running", "uncertain"].includes(session.operation.status),
    );
  async function start() {
    setBusy(true);
    setError("");
    setFeedback(null);
    setChoice(null);
    let attempt = session;
    try {
      if (!attempt || questions.length) {
        attempt = await aiRequest<Session>("/api/practice", "POST", {
          id: crypto.randomUUID(),
          materialId,
        });
        requestKey.current = null;
        setSession(attempt);
      }
      requestKey.current ??= crypto.randomUUID();
      await generate(
        `/api/practice/${attempt.id}/messages`,
        "Generate practice",
        requestKey.current,
        () => {},
      );
      setSession(await aiRequest<Session>(`/api/practice/${attempt.id}`));
      requestKey.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Practice generation failed.");
      if (attempt) {
        const saved = await aiRequest<Session>(
          `/api/practice/${attempt.id}`,
        ).catch(() => attempt);
        setSession(saved);
        if (["failed", "cancelled"].includes(saved?.operation?.status ?? ""))
          requestKey.current = null;
      }
    } finally {
      setBusy(false);
    }
  }
  async function recover(action: string) {
    if (!session) return;
    setError("");
    try {
      const result = await aiRequest<Session>(
        `/api/practice/${session.id}/${action}`,
        "POST",
      );
      setSession(result);
      if (!["running", "uncertain"].includes(result.operation?.status ?? ""))
        requestKey.current = null;
      else
        setError(
          "This request is still unresolved. Check again later; it has not been resent.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    }
  }
  async function submit() {
    if (!session || !current || choice === null) return;
    setBusy(true);
    setError("");
    try {
      setSession(
        await aiRequest<Session>(
          `/api/practice/${session.id}/answers`,
          "POST",
          { position: current.position, answer: choice },
        ),
      );
      setFeedback(current.position);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Answer could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ai-practice" aria-label="Practice questions">
      {loading && <p role="status">Loading practice...</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {active && !questions.length && (
        <>
          <p role="status">
            {busy
              ? "Generating five questions..."
              : "Generation needs your attention."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void recover("recover")}>
              Check saved result
            </Button>
            <Button variant="ghost" onClick={() => void recover("cancel")}>
              Stop generation
            </Button>
          </div>
        </>
      )}
      {!loading && !questions.length && !active && (
        <>
          <h2>Five questions, at your pace</h2>
          <p>
            Practice using this material. Your answers and feedback are saved.
          </p>
          <Button onClick={() => void start()}>
            Generate practice
            <ArrowRight size={16} />
          </Button>
        </>
      )}
      {complete && feedback === null ? (
        <>
          <h2>Practice complete</h2>
          <p className="ai-score">
            {questions.filter((q) => q.answer === q.correct).length} / 5 correct
          </p>
          <h3>Reviewed topics</h3>
          <ul>
            {[...new Set(questions.map((q) => q.topic))].map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
          <h3>Review your answers</h3>
          {questions.map((q) => (
            <article key={q.position} className="ai-review">
              <h4>{q.question}</h4>
              <p>
                {q.answer === q.correct ? "Correct" : "Needs review"}:{" "}
                {q.choices[q.answer!]}
              </p>
              {q.answer !== q.correct && (
                <p>Correct answer: {q.choices[q.correct!]}</p>
              )}
              <p>{q.explanation}</p>
            </article>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void start()}>
              <RotateCcw size={16} />
              New practice
            </Button>
            <ButtonLink href="/history" variant="secondary">
              View history
            </ButtonLink>
          </div>
        </>
      ) : (
        current && (
          <>
            <p className="eyebrow">Question {current.position + 1} of 5</p>
            <progress aria-label="Practice progress" max={5} value={answered} />
            <fieldset disabled={busy || current.answer !== null}>
              <legend>{current.question}</legend>
              <div className="ai-choices">
                {current.choices.map((c, i) => (
                  <label key={i}>
                    <input
                      type="radio"
                      name="practice-answer"
                      checked={(current.answer ?? choice) === i}
                      onChange={() => setChoice(i)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            </fieldset>
            {current.answer === null ? (
              <Button
                disabled={busy || choice === null}
                onClick={() => void submit()}
              >
                Check answer
                <Check size={16} />
              </Button>
            ) : (
              <div role="status">
                <h3>
                  {current.answer === current.correct ? "Correct" : "Not quite"}
                </h3>
                <p>Correct answer: {current.choices[current.correct!]}</p>
                <p>{current.explanation}</p>
                <Button
                  onClick={() => {
                    setFeedback(null);
                    setChoice(null);
                  }}
                >
                  {complete ? "View recap" : "Next question"}
                  <ArrowRight size={16} />
                </Button>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}

export function Practice({ initialId }: { initialId?: string }) {
  const { materials, loading: materialsLoading } = useDemo();
  const params = useSearchParams();
  const [selected, setSelected] = useState(params.get("material") ?? "");
  const [restored, setRestored] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (initialId)
      void aiRequest<Session>(`/api/practice/${initialId}`)
        .then((s) => setRestored(s.material_id))
        .catch((e) => setError(e.message));
  }, [initialId]);
  const material = materials.find((m) => m.id === (restored || selected));
  return (
    <>
      <PageHeading
        eyebrow="BUILD YOUR UNDERSTANDING"
        title={initialId ? "Practice recap" : "Practice"}
      />
      {error && <p role="alert">{error}</p>}
      {materialsLoading ? (
        <p role="status">Loading materials...</p>
      ) : !materials.length ? (
        <EmptyState
          title="Add your first material"
          description="Practice starts with your own notes or PDFs."
        >
          <ButtonLink href="/library">Open library</ButtonLink>
        </EmptyState>
      ) : (
        <>
          <div className="ai-picker">
            <label htmlFor="practice-material">Material</label>
            <select
              id="practice-material"
              value={material?.id ?? ""}
              disabled={Boolean(initialId)}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose a material</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>
          {material && (
            <AiGate key={material.id} materialId={material.id}>
              <PracticeAttempt materialId={material.id} initialId={initialId} />
            </AiGate>
          )}
        </>
      )}
    </>
  );
}
