"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
  MessageSquare,
  AudioLines,
} from "lucide-react";
import { useDemo } from "@/components/demo-provider";
import {
  Button,
  ButtonLink,
  EmptyState,
  IconButton,
  PageHeading,
} from "@/components/ui";
import {
  voiceRoles,
  type VoiceRole,
  type VoiceSession,
  type VoiceStart,
  type VoiceEntry,
} from "@/lib/voice/types";
import { aiRequest } from "./ai-client";
import { AiGate } from "./ai-gate";
import { classifyVoiceError, voiceErrorMessages } from "@/lib/voice/errors";

function VoiceCall({
  materialId,
  initialId,
}: {
  materialId: string;
  initialId?: string;
}) {
  const { preferences } = useDemo();
  const searchParams = useSearchParams();
  const [role, setRole] = useState<VoiceRole>("Classmate");
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [phase, setPhase] = useState("Ready");
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [muted, setMuted] = useState(false);
  const [silent, setSilent] = useState(false);
  const [captions, setCaptions] = useState(preferences.captions);
  const [live, setLive] = useState<(VoiceEntry & { eventId: number })[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const active = useRef<string | null>(null);
  const endedIntentionally = useRef(false);
  const mounted = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const container = useRef<HTMLElement>(null);
  const requestId = useRef<string | null>(null);
  const attempt = useRef(0);
  const [retry, setRetry] = useState(0);
  const reconcile = useCallback(async (id: string) => {
    try {
      const saved = await aiRequest<VoiceSession>(
        `/api/voice-sessions/${id}/reconcile`,
        "POST",
      );
      if (mounted.current) {
        setSession(saved);
        if (saved.status === "failed")
          setError(
            `${voiceErrorMessages.generation_failure} Reference: ${saved.diagnosticReference ?? "unavailable"}`,
          );
      }
    } catch {
      if (mounted.current)
        setError(
          "The final transcript is not ready yet. Check the saved session again shortly.",
        );
    }
  }, []);
  const disconnected = useCallback(() => {
    attempt.current += 1;
    const id = active.current;
    active.current = null;
    if (mounted.current) {
      setPhase("Ended");
      setBusy(false);
    }
    if (id)
      void aiRequest<VoiceSession>(
        `/api/voice-sessions/${id}/${endedIntentionally.current ? "end" : "disconnect"}`,
        "POST",
      )
        .then((saved) => {
          if (mounted.current) setSession(saved);
          return reconcile(id);
        })
        .catch(() => {
          if (mounted.current)
            setError("Connection ended. Check the saved session status.");
        });
  }, [reconcile]);
  const conversation = useConversation({
    micMuted: muted,
    volume: silent ? 0 : 1,
    onConnect: ({ conversationId }) => {
      const id = active.current;
      if (!id || !mounted.current) {
        conversation.endSession();
        return;
      }
      void aiRequest<VoiceSession>(`/api/voice-sessions/${id}/bind`, "POST", {
        conversationId,
      })
        .then((saved) => {
          if (mounted.current && active.current === id) {
            setSession(saved);
            setPhase("Listening");
            setBusy(false);
          }
        })
        .catch((error: unknown) => {
          if (mounted.current)
            setError(
              error instanceof Error
                ? error.message
                : "The voice connection could not be verified. Please check the saved session.",
            );
          conversation.endSession();
          disconnected();
        });
    },
    onDisconnect: disconnected,
    onError: (message, context) => {
      if (mounted.current)
        setError(
          `${voiceErrorMessages[classifyVoiceError(`${message ?? ""} ${typeof context?.code === "number" ? context.code : ""}`)]} Reference: ${session?.diagnosticReference ?? "unavailable"}`,
        );
      conversation.endSession();
      disconnected();
    },
    onMessage: (event) => {
      if (!mounted.current) return;
      setLive((entries) => [
        ...entries.filter(
          (e) => e.eventId !== event.event_id || e.role !== event.role,
        ),
        {
          eventId: event.event_id,
          role: event.role,
          message: event.message,
          time: 0,
        },
      ]);
      setPhase(event.role === "user" ? "Thinking" : "Speaking");
    },
    onModeChange: ({ mode }) => {
      if (mounted.current)
        setPhase(mode === "speaking" ? "Speaking" : "Listening");
    },
    onInterruption: () => {
      // Provider HTTP cancellation identifies the exact turn; a browser event
      // cannot safely cancel whichever operation happens to be active now.
      setPhase("Listening");
      if (mounted.current) setPhase("Listening");
    },
    onAgentResponseCorrection: (event) => {
      if (mounted.current)
        setLive((entries) =>
          entries.map((entry) =>
            entry.role === "agent" && entry.eventId === event.event_id
              ? { ...entry, message: event.corrected_agent_response }
              : entry,
          ),
        );
    },
  });
  const endSession = conversation.endSession;
  useEffect(() => {
    mounted.current = true;
    function leave() {
      attempt.current += 1;
      const id = active.current ?? requestId.current;
      active.current = null;
      endSession();
      if (id)
        void fetch(`/api/voice-sessions/${id}/disconnect`, {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
    }
    function navigate(event: MouseEvent) {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const destination = new URL(link.href, window.location.href);
      if (
        ["http:", "https:"].includes(destination.protocol) &&
        (destination.origin !== location.origin ||
          destination.pathname !== location.pathname ||
          destination.search !== location.search)
      )
        leave();
    }
    document.addEventListener("click", navigate, true);
    window.addEventListener("popstate", leave);
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      document.removeEventListener("click", navigate, true);
      window.removeEventListener("popstate", leave);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [endSession]);
  useEffect(() => {
    let alive = true;
    void aiRequest("/api/voice-sessions/configuration")
      .then(() => {
        if (alive) {
          setAvailable(true);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    if (initialId && active.current !== initialId)
      void aiRequest<VoiceSession>(`/api/voice-sessions/${initialId}`)
        .then((saved) => {
          if (alive && active.current !== initialId) {
            setSession(saved);
            setRole(saved.role);
            setPhase("Saved session");
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [initialId, retry]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (
        active.current &&
        session &&
        Date.now() >= new Date(session.expiresAt).getTime()
      ) {
        endedIntentionally.current = true;
        endSession();
        disconnected();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [session, endSession, disconnected]);
  async function start() {
    endedIntentionally.current = false;
    const ticket = ++attempt.current;
    setBusy(true);
    setError("");
    setPhase("Connecting");
    setConsent(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Microphone access requires HTTPS or localhost in a supported browser.",
        );
      const permission = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      permission.getTracks().forEach((track) => track.stop());
      if (!mounted.current || ticket !== attempt.current) return;
      requestId.current ??=
        searchParams.get("diagnosticSession") ?? crypto.randomUUID();
      const result = await aiRequest<VoiceStart>(
        "/api/voice-sessions",
        "POST",
        { id: requestId.current, materialId, role, consent: true },
      );
      if (!mounted.current || ticket !== attempt.current) {
        await aiRequest(
          `/api/voice-sessions/${result.session.id}/disconnect`,
          "POST",
        );
        return;
      }
      active.current = result.session.id;
      setSession(result.session);
      setLive([]);
      setMuted(false);
      setSilent(false);
      window.history.replaceState(
        null,
        "",
        `/voice?session=${result.session.id}&material=${materialId}`,
      );
      conversation.startSession({
        conversationToken: result.conversationToken,
        connectionType: "webrtc",
        userId: result.alias,
        customLlmExtraBody: { voice_capability: result.capability },
        overrides: { tts: { speed: result.speed } },
      });
    } catch (e) {
      if (!mounted.current || ticket !== attempt.current) return;
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access to start a voice session."
          : e instanceof Error
            ? e.message
            : "The call could not start.",
      );
      setPhase("Connection error");
      setBusy(false);
      if (requestId.current) {
        const saved = await aiRequest<VoiceSession>(
          `/api/voice-sessions/${requestId.current}`,
        ).catch(() => null);
        if (saved) setSession(saved);
        else requestId.current = null;
      }
    }
  }
  const connected =
    conversation.status === "connected" || conversation.status === "connecting";
  const unresolved =
    session && ["starting", "active", "uncertain"].includes(session.status);
  const seconds = session
    ? Math.min(
        600,
        Math.max(
          0,
          Math.ceil((new Date(session.expiresAt).getTime() - now) / 1000),
        ),
      )
    : 600;
  const transcript = session?.transcriptFinal ? session.transcript : live;
  return (
    <section
      ref={container}
      tabIndex={-1}
      className="voice-call"
      data-transcript={captions}
      aria-label="Voice role-play controls"
    >
      <div className="voice-call-main">
        <div className="ai-modes" role="group" aria-label="Role-play partner">
          {voiceRoles.map((value) => (
            <button
              key={value}
              aria-pressed={role === value}
              data-state={role === value ? "active" : "inactive"}
              disabled={connected || busy}
              onClick={() => setRole(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="voice-stage">
          <AudioLines size={44} strokeWidth={1.4} aria-hidden="true" />
          <h2>{role}</h2>
          <p role="status">
            {phase}
            {muted && connected ? " · Microphone muted" : ""}
          </p>
          {connected && (
            <time aria-label="Time remaining">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </time>
          )}
          <p className="small-muted">
            Up to 10 minutes. Muting does not pause the session timer or usage.
          </p>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="voice-controls">
          {connected || busy ? (
            <>
              <IconButton
                label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
                onClick={() => setMuted((v) => !v)}
              >
                {muted ? <MicOff /> : <Mic />}
              </IconButton>
              <IconButton
                label={silent ? "Unmute speaker" : "Mute speaker"}
                aria-pressed={silent}
                onClick={() => setSilent((v) => !v)}
              >
                {silent ? <VolumeX /> : <Volume2 />}
              </IconButton>
              <Button
                onClick={() => {
                  endedIntentionally.current = true;
                  endSession();
                  disconnected();
                }}
              >
                <PhoneOff size={17} />
                End session
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={!available || Boolean(unresolved)}
                onClick={() => {
                  requestId.current = null;
                  opener.current = document.activeElement as HTMLElement;
                  setConsent(true);
                }}
              >
                <Mic size={17} />
                {session ? "Start new session" : "Start voice session"}
              </Button>
              {!available && (
                <Button variant="ghost" onClick={() => setRetry((v) => v + 1)}>
                  Check configuration
                </Button>
              )}
            </>
          )}
          <IconButton
            label={captions ? "Hide transcript" : "Show transcript"}
            aria-pressed={captions}
            onClick={() => setCaptions((v) => !v)}
          >
            <MessageSquare size={19} />
          </IconButton>
        </div>
        {session && !connected && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void reconcile(session.id)}
            >
              Check saved transcript
            </Button>
            {unresolved && (
              <Button
                variant="ghost"
                onClick={() =>
                  void aiRequest<VoiceSession>(
                    `/api/voice-sessions/${session.id}/end`,
                    "POST",
                  )
                    .then(setSession)
                    .catch((e) => setError(e.message))
                }
              >
                End saved session
              </Button>
            )}
            <ButtonLink href="/history" variant="ghost">
              View history
            </ButtonLink>
          </div>
        )}
      </div>
      {captions && (
        <section
          className="voice-transcript"
          aria-label="Voice transcript"
          tabIndex={0}
        >
          <h3>
            {session?.transcriptFinal
              ? "Saved transcript"
              : connected
                ? "Live transcript"
                : "Transcript"}
          </h3>
          {!session?.transcriptFinal && (
            <p className="small-muted">
              The saved transcript is verified with ElevenLabs after the call.
              No audio recordings are stored.
            </p>
          )}
          {!transcript.length ? (
            <p className="small-muted">
              {session
                ? "The verified transcript is not available yet."
                : "Your conversation will appear here."}
            </p>
          ) : (
            transcript.map((entry, index) => (
              <article className="ai-message" key={index}>
                <strong>
                  {entry.role === "user" ? "You" : (session?.role ?? role)}
                </strong>
                <p>{entry.message}</p>
              </article>
            ))
          )}
        </section>
      )}
      <Dialog.Root open={consent} onOpenChange={setConsent}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (opener.current?.isConnected) opener.current.focus();
              else container.current?.focus();
            }}
          >
            <Dialog.Title>Start a live voice session?</Dialog.Title>
            <Dialog.Description>
              Your microphone audio is processed by ElevenLabs. Conversation
              text is processed by Backboard and its model providers using this
              material. Transcripts are saved privately; audio recording is
              disabled. ElevenLabs may retain transcripts for up to seven days.
              The call ends after ten minutes.
            </Dialog.Description>
            <div className="dialog-actions">
              <Button variant="secondary" onClick={() => setConsent(false)}>
                Cancel
              </Button>
              <Button onClick={() => void start()}>Agree and start</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
export function Voice() {
  const { materials, loading } = useDemo();
  const params = useSearchParams();
  const initialId = params.get("session") ?? undefined;
  const [selected, setSelected] = useState(params.get("material") ?? "");
  const [restored, setRestored] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (initialId)
      void aiRequest<VoiceSession>(`/api/voice-sessions/${initialId}`)
        .then((s) => setRestored(s.materialId))
        .catch((e) => setError(e.message));
  }, [initialId]);
  const material = materials.find((m) => m.id === (restored || selected));
  return (
    <>
      <PageHeading eyebrow="TALK IT THROUGH" title="Voice role-play" />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading materials...</p>
      ) : !materials.length ? (
        <EmptyState
          title="Add a material to talk through"
          description="Choose your own notes or a PDF to start a role-play."
        >
          <ButtonLink href="/library">Open library</ButtonLink>
        </EmptyState>
      ) : (
        <>
          <div className="ai-picker">
            <label htmlFor="voice-material">Material</label>
            <select
              id="voice-material"
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
              <ConversationProvider>
                <VoiceCall materialId={material.id} initialId={initialId} />
              </ConversationProvider>
            </AiGate>
          )}
        </>
      )}
    </>
  );
}
