// The canvas in a chat (MCP Apps): connect to the host, read the injected
// config, pair if needed, then mount the one canvas over the HTTP canvas
// client with the person's token. The canvas never calls tools through the
// host: those would run on the agent's connection. The frame keeps the design
// system's palette and takes only the host's fonts. Inline, the frame is as
// tall as its content (the App reports each size change to the host with
// `ui/notifications/size-changed`) and shows a compact canvas: title, as-of,
// unsaved changes and Save; Review, Comments and the other controls are in Full
// screen, where the frame fills the host's height. The person's selection and
// actions reach the model with `updateModelContext` (never a token or a code).
import "./styles.css";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { Button } from "@autograph/components";
import { Canvas } from "@autograph/canvas";
import { bootstrapAgCharts } from "@autograph/compositions";
import { bootstrapAgGrid } from "@modules/editable-grid";

import { createCanvasHttpClient } from "../client";
import { createFrameSession, type FrameSession } from "./client";
import { loadViewer, type Viewer } from "./viewer";
import { readFrameConfig, type CanvasFrameConfig } from "./config";
import { createModelContext, observedClient } from "./context";
import { PairingPanel } from "./pairing";
import { applyHostTheme } from "./theme";

/** The session the agent's `open_canvas` named, from its structured result. */
const sessionOf = (structured: unknown): string | null => {
  const id = (structured as { session_id?: unknown } | null)?.session_id;
  return typeof id === "string" ? id : null;
};

type ModelContext = ReturnType<typeof createModelContext>;

function FrameCanvas(props: {
  app: App;
  config: CanvasFrameConfig;
  session: FrameSession;
  sessionId: string | null;
  context: ModelContext;
  fullscreen: boolean;
}) {
  const { app, config, session, sessionId, context, fullscreen } = props;
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useMemo(
    () =>
      observedClient(
        createCanvasHttpClient(
          {
            url: config.canvasUrl,
            bearer: session.bearer,
            // Streams are shared across tabs only within one signed-in identity.
            identity: () => {
              const who = session.identity();
              return who === null ? null : `${who.personId}:${who.organizationId}`;
            },
          },
          config.definition,
          {
            canApprove: viewer?.canApprove ?? false,
            authors: viewer?.authors ?? false,
            ...(config.moneyDefaults === undefined ? {} : { moneyDefaults: config.moneyDefaults }),
          },
        ),
        (action, sentence) => context.action(action, sentence),
      ),
    [config, session, viewer, context],
  );
  // Loading the viewer: a refused sign-in returns to the sign-in panel; any
  // other failure is an explicit state with Try again, never a stuck Loading.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void loadViewer(config, session).then((loaded) => {
      if (cancelled) return;
      if (loaded.kind === "viewer") setViewer(loaded.viewer);
      else if (loaded.kind === "failed") setError(loaded.message);
    });
    return () => {
      cancelled = true;
    };
  }, [config, session, attempt]);
  if (error !== null)
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-[var(--space-3)] p-[var(--space-6)] text-[length:var(--text-body)] text-[var(--color-text-primary)]"
      >
        <p>{error}</p>
        <Button intent="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  if (viewer === null || sessionId === null)
    return (
      <p className="p-[var(--space-6)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        {viewer === null ? "Loading…" : "Opening the session…"}
      </p>
    );
  return (
    <Canvas
      client={client}
      compact={!fullscreen}
      headerActions={<FullScreenButton app={app} />}
      sessionId={sessionId}
      onSelectionChange={context.select}
    />
  );
}

/** The host's context, as it changes. */
function useHostContext(app: App): McpUiHostContext | undefined {
  const [context, setContext] = useState(app.getHostContext());
  useEffect(() => hostContexts.subscribe(() => setContext(app.getHostContext())), [app]);
  return context;
}
const hostContexts = (() => {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed() {
      for (const listener of [...listeners]) listener();
    },
  };
})();

/** Full screen, or back, where the host offers both. */
function FullScreenButton({ app }: { app: App }) {
  const host = useHostContext(app);
  const modes = host?.availableDisplayModes ?? [];
  if (!modes.includes("fullscreen") || !modes.includes("inline")) return null;
  const full = host?.displayMode === "fullscreen";
  return (
    <Button
      className="shrink-0 whitespace-nowrap"
      data-display-mode-toggle
      intent="secondary"
      size="sm"
      onClick={() => void app.requestDisplayMode({ mode: full ? "inline" : "fullscreen" })}
    >
      {full ? "Exit full screen" : "Full screen"}
    </Button>
  );
}

/** The session to show: the latest `open_canvas` result. Heard from before `connect`. */
function createOpenedSession(app: App) {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  app.ontoolresult = (result) => {
    const id = sessionOf(result.structuredContent);
    if (id === null || id === current) return;
    current = id;
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => current,
  };
}

function FrameRoot(props: {
  app: App;
  config: CanvasFrameConfig;
  session: FrameSession;
  opened: ReturnType<typeof createOpenedSession>;
  context: ModelContext;
}) {
  const { app, config, session, opened, context } = props;
  const [signedIn, setSignedIn] = useState(session.hasStoredSignIn());
  const sessionId = useSyncExternalStore(opened.subscribe, opened.get);
  // Token loss, or pairing again, shows the sign-in panel; the canvas, its
  // stream and what the model heard of this person's work are cleared.
  useEffect(
    () =>
      session.onChange((next) => {
        if (!next) context.reset();
        setSignedIn(next);
      }),
    [session, context],
  );
  const host = useHostContext(app);
  const fullscreen = host?.displayMode === "fullscreen";
  // Full screen fills the host's height; inline, the document is as tall as
  // its content and the App's auto-resize reports that height to the host.
  useEffect(() => {
    document.documentElement.dataset.displayMode = fullscreen ? "fullscreen" : "inline";
  }, [fullscreen]);
  if (!signedIn)
    return (
      <PairingPanel
        title={config.title}
        session={session}
        openLink={(url) => app.openLink({ url })}
      />
    );
  return (
    <div
      className={
        fullscreen
          ? "flex h-screen flex-col"
          : "flex min-h-[var(--size-editor-popover-md)] flex-col"
      }
      data-frame-canvas
    >
      <FrameCanvas
        app={app}
        config={config}
        context={context}
        fullscreen={fullscreen}
        session={session}
        sessionId={sessionId}
      />
    </div>
  );
}

async function main() {
  const config = readFrameConfig(document);
  const root = createRoot(document.getElementById("root")!);
  if (config === null) {
    root.render(
      <p className="p-[var(--space-6)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        This canvas was served without its config.
      </p>,
    );
    return;
  }
  // The canvas's grids and charts need their modules once; the keys are public.
  await bootstrapAgGrid({ licenseKey: config.agGridLicenseKey ?? undefined });
  bootstrapAgCharts({ licenseKey: config.agChartsLicenseKey ?? undefined });
  // `autoResize` (the default, spelled out) sends `ui/notifications/size-changed`
  // whenever the document's content height changes.
  const app = new App(
    { name: "Autograph canvas", version: "1.0.0" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: true },
  );
  app.onhostcontextchanged = (change) => {
    applyHostTheme(change);
    hostContexts.changed();
  };
  const opened = createOpenedSession(app);
  const session = createFrameSession(config);
  const context = createModelContext({
    definition: config.definition,
    send: (update) => app.updateModelContext(update),
  });
  root.render(
    <FrameRoot app={app} config={config} context={context} opened={opened} session={session} />,
  );
  await app.connect();
  const host = app.getHostContext();
  if (host !== undefined) applyHostTheme(host);
  hostContexts.changed();
}

void main();
