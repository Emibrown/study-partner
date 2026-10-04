"use client";
// Browser-only synthetic audio fixture, selected exclusively by isolated test config.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
type Options = {
  micMuted: boolean;
  volume: number;
  onConnect(event: { conversationId: string }): void;
  onDisconnect(): void;
  onError(): void;
  onMessage(event: {
    role: "user" | "agent";
    message: string;
    event_id: number;
  }): void;
  onModeChange(event: { mode: string }): void;
};
export function ConversationProvider({ children }: { children: ReactNode }) {
  return children;
}
export function useConversation(options: Options) {
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });
  const stream = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState("disconnected");
  const generation = useRef(0);
  const endSession = useCallback(() => {
    generation.current++;
    const wasActive = Boolean(stream.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setStatus("disconnected");
    if (wasActive) callbacks.current.onDisconnect();
  }, []);
  const startSession = useCallback(
    (input: {
      userId: string;
      customLlmExtraBody: { voice_capability: string };
    }) => {
      const ticket = ++generation.current;
      setStatus("connecting");
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((media) => {
          if (ticket !== generation.current) {
            media.getTracks().forEach((t) => t.stop());
            return;
          }
          stream.current = media;
          setStatus("connected");
          callbacks.current.onConnect({
            conversationId: `conv_${input.userId.replaceAll("-", "")}`,
          });
          callbacks.current.onModeChange({ mode: "listening" });
          callbacks.current.onMessage({
            role: "user",
            message: "Explain the solar cart",
            event_id: 1,
          });
          callbacks.current.onMessage({
            role: "agent",
            message: "The battery stores energy.",
            event_id: 2,
          });
        })
        .catch(() => callbacks.current.onError());
    },
    [],
  );
  useEffect(() => {
    stream.current?.getAudioTracks().forEach((t) => {
      t.enabled = !options.micMuted;
    });
  }, [options.micMuted]);
  useEffect(() => {
    const fail = () => callbacks.current.onError();
    window.addEventListener("voice-fixture-error", fail);
    return () => window.removeEventListener("voice-fixture-error", fail);
  }, []);
  return { status, endSession, startSession };
}
