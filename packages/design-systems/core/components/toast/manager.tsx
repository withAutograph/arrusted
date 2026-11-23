import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { AutoDismissToast, type ToastAction, type ToastVariant } from "./toast";

// Default auto-dismiss in ms. 8s matches the design brief — long enough
// to read a multi-line save outcome, short enough not to clutter the
// page if the user ignores it.
export const DEFAULT_TOAST_DURATION_MS = 8000;

export type ToastOptions = {
  duration?: number;
  action?: ToastAction;
};

export type ToastApi = {
  success: (message: ReactNode, options?: ToastOptions) => string;
  warning: (message: ReactNode, options?: ToastOptions) => string;
  error: (message: ReactNode, options?: ToastOptions) => string;
  info: (message: ReactNode, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
};

type ToastEntry = {
  id: string;
  variant: ToastVariant;
  message: ReactNode;
  action?: ToastAction;
  duration: number;
};

const ToastApiContext = createContext<ToastApi | null>(null);

function makeId(): string {
  // No randomness requirement — just needs to be unique within a session
  // for React keys + dismiss().
  return `toast-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export type ToastProviderProps = {
  children: ReactNode;
  defaultDuration?: number;
};

export function ToastProvider(props: ToastProviderProps) {
  const { children, defaultDuration = DEFAULT_TOAST_DURATION_MS } = props;
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  // Mirror duration into a ref so the imperative API memo can stay stable
  // across renders even when consumers pass an inline number.
  const defaultDurationRef = useRef(defaultDuration);
  useEffect(() => {
    defaultDurationRef.current = defaultDuration;
  }, [defaultDuration]);

  const dismiss = useCallback((id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: ReactNode, options?: ToastOptions): string => {
      const id = makeId();
      const duration = options?.duration ?? defaultDurationRef.current;
      const entry: ToastEntry = { id, variant, message, action: options?.action, duration };
      setEntries((current) => [...current, entry]);
      return id;
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, options) => push("success", message, options),
      warning: (message, options) => push("warning", message, options),
      error: (message, options) => push("error", message, options),
      info: (message, options) => push("info", message, options),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastApiContext.Provider value={api}>
      {children}
      <ToastViewport entries={entries} dismiss={dismiss} />
    </ToastApiContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = use(ToastApiContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

// Fixed-position stack in the bottom-right. Renders into document.body
// via portal so it escapes any parent stacking context (mirrors the
// Sheet/Modal pattern). Stack grows upward — newest at the bottom — so
// the eye anchors on the most recent message without older toasts
// jumping.
function ToastViewport(props: { entries: ToastEntry[]; dismiss: (id: string) => void }) {
  if (typeof document === "undefined") return null;
  if (props.entries.length === 0) return null;
  return createPortal(
    <div
      data-toast-viewport
      // pointer-events-none on the wrapper, pointer-events-auto on each
      // toast: clicks pass through empty space so the toast layer can't
      // accidentally block the page underneath when most of the corner
      // is empty.
      className="pointer-events-none fixed bottom-[var(--space-4)] right-[var(--space-4)] z-[var(--z-overlay)] flex flex-col gap-[var(--space-2)] items-end"
    >
      {props.entries.map((entry) => (
        <AutoDismissToast
          key={entry.id}
          variant={entry.variant}
          message={entry.message}
          action={entry.action}
          duration={entry.duration}
          onDismiss={() => props.dismiss(entry.id)}
        />
      ))}
    </div>,
    document.body,
  );
}
