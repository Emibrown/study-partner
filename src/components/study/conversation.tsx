"use client";
import { useEffect, useRef, useState } from "react";
import { Plus, Send, Square } from "lucide-react";
import { modes, type Session, type StudyMode } from "@/lib/ai/types";
import { Button, ButtonLink, IconButton } from "@/components/ui";
import { aiRequest, generate } from "./ai-client";
import { useDemo } from "@/components/demo-provider";

const suggestions: Record<StudyMode, string[]> = {
  Explain: [
    "Explain the main ideas in this material.",
    "Help me understand the most important concept.",
  ],
  Quiz: ["Ask me one question about this material."],
  "Explain It Back": ["Choose a concept for me to explain in my own words."],
};
export function Conversation({ materialId }: { materialId: string }) {
  const { preferences } = useDemo();
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<StudyMode>(
    () =>
      modes.find((m) => m.toLowerCase() === preferences.mode.toLowerCase()) ??
      "Explain",
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const request = useRef<{ key: string; content: string } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const active =
    busy ||
    Boolean(
      session?.operation &&
      ["running", "uncertain"].includes(session.operation.status),
    );
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const result = await aiRequest<{ sessions: Session[] }>(
          `/api/study-sessions?materialId=${materialId}`,
        );
        const requested = new URLSearchParams(window.location.search).get(
          "session",
        );
        const previous = result.sessions.find(
          (s) => s.kind === "study" && (!requested || s.id === requested),
        );
        const data = previous
          ? await aiRequest<Session>(`/api/study-sessions/${previous.id}`)
          : null;
        if (alive) {
          setSession(data);
          if (data) setMode(data.mode as StudyMode);
          setPartial(data?.operation?.output ?? "");
          if (["failed", "cancelled"].includes(data?.operation?.status ?? ""))
            request.current = null;
        }
      } catch (e) {
        if (alive)
          setError(
            e instanceof Error ? e.message : "Conversation unavailable.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [materialId, version]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [partial, session]);
  async function create() {
    const result = await aiRequest<Session>("/api/study-sessions", "POST", {
      id: crypto.randomUUID(),
      materialId,
      mode,
    });
    setSession(result);
    setPartial("");
    request.current = null;
    window.history.replaceState(
      null,
      "",
      `/study/${materialId}?session=${result.id}`,
    );
    return result;
  }
  async function send() {
    if (!text.trim() || active) return;
    setBusy(true);
    setError("");
    setPartial("");
    try {
      const current = session ?? (await create());
      if (!request.current || request.current.content !== text.trim())
        request.current = { key: crypto.randomUUID(), content: text.trim() };
      await generate(
        `/api/study-sessions/${current.id}/messages`,
        request.current.content,
        request.current.key,
        (delta) => setPartial((p) => p + delta),
      );
      setSession(await aiRequest<Session>(`/api/study-sessions/${current.id}`));
      setText("");
      setPartial("");
      request.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message could not be sent.");
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  async function action(action: "recover" | "cancel") {
    if (!session) return;
    setError("");
    try {
      const data = await aiRequest<Session>(
        `/api/study-sessions/${session.id}/${action}`,
        "POST",
      );
      setSession(data);
      setPartial(data.operation?.output ?? "");
      if (
        data.operation &&
        !["running", "uncertain"].includes(data.operation.status)
      )
        request.current = null;
      if (data.operation?.status === "uncertain")
        setError(
          "The provider outcome is still uncertain. Check again later or reset this material's AI data. It has not been resent.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    }
  }
  async function changeMode(value: StudyMode) {
    setError("");
    try {
      if (session)
        setSession(
          await aiRequest<Session>(
            `/api/study-sessions/${session.id}`,
            "PATCH",
            { mode: value },
          ),
        );
      setMode(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mode could not be saved.");
    }
  }
  return (
    <section className="ai-conversation" aria-label="Study conversation">
      <div className="ai-toolbar">
        <h2>Study conversation</h2>
        <IconButton
          label="New session"
          disabled={active || loading}
          onClick={() => {
            setBusy(true);
            void create()
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <Plus size={18} />
        </IconButton>
      </div>
      <div className="ai-modes" role="group" aria-label="Study mode">
        {modes.map((m) => (
          <button
            key={m}
            aria-pressed={mode === m}
            data-state={mode === m ? "active" : "inactive"}
            disabled={active}
            onClick={() => void changeMode(m)}
          >
            {m}
          </button>
        ))}
      </div>
      <div
        ref={log}
        className="ai-messages"
        aria-label="Conversation messages"
        aria-busy={busy}
      >
        {loading ? (
          <p role="status">Loading conversation...</p>
        ) : (
          !session?.messages.length && (
            <p className="small-muted">What would you like to work on?</p>
          )
        )}
        {session?.messages.map((m) =>
          m.role === "mode" ? (
            <p className="small-muted" key={m.id}>
              Mode: {m.content}
            </p>
          ) : (
            <article className={`ai-message ${m.role}`} key={m.id}>
              <strong>{m.role === "user" ? "You" : "Study Partner"}</strong>
              <p>{m.content}</p>
            </article>
          ),
        )}
        {partial && (
          <article className="ai-message assistant">
            <strong>Study Partner</strong>
            <p>{partial}</p>
          </article>
        )}
      </div>
      <p className="sr-only" role="status">
        {busy
          ? "Study Partner is responding."
          : partial
            ? "Partial response available."
            : "Conversation ready."}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {active && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void action("cancel")}>
            <Square size={14} />
            Stop generation
          </Button>
          <Button variant="ghost" onClick={() => void action("recover")}>
            Check saved result
          </Button>
        </div>
      )}
      {!active && !loading && (
        <div className="ai-suggestions">
          {suggestions[mode].map((s) => (
            <button key={s} onClick={() => setText(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="study-message">Your message</label>
        <textarea
          id="study-message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          rows={3}
          disabled={active || loading}
          placeholder={
            mode === "Explain It Back"
              ? "Explain a concept in your own words..."
              : "Ask about your material..."
          }
        />
        <div className="ai-toolbar">
          <span className="small-muted">
            {text.length.toLocaleString()} / 8,000
          </span>
          <Button type="submit" disabled={active || loading || !text.trim()}>
            <Send size={16} />
            Send
          </Button>
        </div>
      </form>
      <ButtonLink variant="secondary" href={`/practice?material=${materialId}`}>
        Practice this material
      </ButtonLink>
      <ButtonLink variant="secondary" href={`/voice?material=${materialId}`}>
        Voice role-play
      </ButtonLink>
    </section>
  );
}
