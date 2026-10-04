"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultPreferences, type Preferences } from "@/lib/fixtures";
import type { Material } from "@/lib/materials/types";

type WorkspaceContext = {
  user: { id: string; name: string; email: string } | null;
  materials: Material[];
  loading: boolean;
  materialsError: string;
  pdfUploadsAvailable: boolean;
  refreshMaterials: () => Promise<void>;
  preferences: Preferences;
  setPreferences: (preferences: Preferences) => void;
  addNotesOpen: boolean;
  setAddNotesOpen: (open: boolean) => void;
};
const Context = createContext<WorkspaceContext | null>(null);
export function DemoProvider({
  children,
  user = null,
  initialPreferences = defaultPreferences,
}: {
  children: ReactNode;
  user?: WorkspaceContext["user"];
  initialPreferences?: Preferences;
}) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(Boolean(user));
  const [materialsError, setError] = useState("");
  const [pdfUploadsAvailable, setPdfUploadsAvailable] = useState(false);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [addNotesOpen, setAddNotesOpen] = useState(false);
  const userId = user?.id;
  const latestRequest = useRef(0);
  const refreshMaterials = useCallback(async () => {
    if (!userId) return;
    const requestId = ++latestRequest.current;
    setLoading(true);
    try {
      const response = await fetch("/api/materials", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load materials");
      const data = await response.json();
      if (requestId !== latestRequest.current) return;
      setMaterials(data.materials);
      setPdfUploadsAvailable(data.pdfUploadsAvailable);
      setError("");
    } catch {
      if (requestId !== latestRequest.current) return;
      setMaterials([]);
      setError("Your library couldn't be loaded. Please try again.");
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [userId]);
  // Fetch external, user-owned state on mount; the layout remounts this provider per account.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshMaterials();
    return () => {
      // This is a request-generation counter, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      latestRequest.current++;
    };
  }, [refreshMaterials]);
  return (
    <Context.Provider
      value={{
        user,
        materials,
        loading,
        materialsError,
        pdfUploadsAvailable,
        refreshMaterials,
        preferences,
        setPreferences,
        addNotesOpen,
        setAddNotesOpen,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useDemo() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace provider missing");
  return context;
}
