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

import { Sheet } from "./sheet";

export type SheetCloseReason = "escape" | "backdrop" | "close-button" | "programmatic" | string;

export type SheetPayload = {
  title: ReactNode;
  content: ReactNode;
  footer?: ReactNode;
  width?: string;
  backdrop?: boolean;
  onBeforeClose?: (reason?: SheetCloseReason) => boolean | Promise<boolean>;
};

export type SheetManager = {
  openSheet: (payload: SheetPayload) => Promise<boolean>;
  closeSheet: (reason?: SheetCloseReason) => Promise<boolean>;
  isOpen: boolean;
};

const SheetContext = createContext<SheetManager | null>(null);

type SheetState = { open: boolean; payload: SheetPayload | null };

type SheetProviderInternal = SheetManager & { state: SheetState };

const SheetStateContext = createContext<SheetProviderInternal | null>(null);

export function SheetProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<SheetState>({ open: false, payload: null });
  const payloadRef = useRef<SheetPayload | null>(null);
  useEffect(() => {
    payloadRef.current = state.payload;
  }, [state.payload]);

  const closeSheet = useCallback(async (reason?: SheetCloseReason): Promise<boolean> => {
    // Capture the payload identity at entry so a re-open during the awaited
    // onBeforeClose doesn't cause us to clear the wrong sheet on resume.
    const current = payloadRef.current;
    if (!current) {
      return true;
    }
    if (current.onBeforeClose) {
      const allow = await current.onBeforeClose(reason);
      if (!allow) {
        return false;
      }
    }
    if (payloadRef.current !== current) {
      // The sheet was replaced (or closed) while we were awaiting the guard.
      // The current owner of the slot decides its own lifecycle; bail.
      return true;
    }
    setState({ open: false, payload: null });
    return true;
  }, []);

  const openSheet = useCallback(
    async (payload: SheetPayload): Promise<boolean> => {
      // If a sheet is already open, give its onBeforeClose a chance to veto
      // the replacement (dirty-discard guards, etc.). Read payloadRef rather
      // than state so this callback stays stable across opens.
      if (payloadRef.current) {
        const closed = await closeSheet("replaced");
        if (!closed) return false;
      }
      setState({ open: true, payload });
      return true;
    },
    [closeSheet],
  );

  const manager = useMemo<SheetProviderInternal>(
    () => ({ openSheet, closeSheet, isOpen: state.open, state }),
    [closeSheet, openSheet, state],
  );

  return (
    <SheetContext.Provider value={manager}>
      <SheetStateContext.Provider value={manager}>{props.children}</SheetStateContext.Provider>
    </SheetContext.Provider>
  );
}

export function useSheet(): SheetManager {
  const ctx = use(SheetContext);
  if (!ctx) {
    throw new Error("useSheet must be used within a <SheetProvider>");
  }
  return ctx;
}

export function SheetRenderer() {
  const ctx = use(SheetStateContext);
  if (!ctx) {
    throw new Error("<SheetRenderer> must be rendered inside a <SheetProvider>");
  }
  const closeSheet = ctx?.closeSheet;
  // Stable handler so Sheet's keydown effect (deps include onClose) doesn't
  // re-bind document listeners on every parent re-render.
  const handleClose = useCallback(
    (reason?: SheetCloseReason) => {
      if (closeSheet) {
        void closeSheet(reason);
      }
    },
    [closeSheet],
  );
  if (typeof document === "undefined") {
    return null;
  }
  const payload = ctx.state.payload;
  return createPortal(
    <Sheet
      open={ctx.state.open && payload !== null}
      title={payload?.title ?? ""}
      footer={payload?.footer}
      width={payload?.width}
      backdrop={payload?.backdrop}
      onClose={handleClose}
    >
      {payload?.content}
    </Sheet>,
    document.body,
  );
}
