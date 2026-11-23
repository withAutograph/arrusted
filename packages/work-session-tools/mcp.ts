import { randomUUID } from "node:crypto";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import {
  createDataClient,
  type DataContext,
  type DataDefinition,
  type WorkTarget,
} from "@autograph/generated-app-runtime/data";
import { z } from "zod";
import { createWorkSessionToolCore } from "./core";

/** An already verified agent: the route authenticates the user before building this. */
export type WorkSessionMcpInput = {
  definition: DataDefinition;
  /**
   * Identity of the client connection, unique per connection: JSON-RPC ids
   * restart with each client session, and with the call id this derives each
   * call's request ID. The authenticated MCP route supplies it (item 3b, from
   * the OAuth grant); the MCP session id is folded in when there is one.
   */
  conversationId: string;
  /** Opens the platform agent context for one turn (one turn per tool call). */
  contextForTurn: (turnId: string) => DataContext;
  server?: { name: string; version: string };
  /** The canvas as an MCP App: its resource and `open_canvas` (item 5b). */
  canvas?: WorkSessionMcpCanvas;
};

/** The canvas resource an app serves to MCP hosts that render views. */
export type WorkSessionMcpCanvas = {
  /**
   * The `ui://` resource's contents, read when the host asks (HTML, MIME
   * type, `_meta.ui`). Absent (the app has no built view): no resources
   * capability and no `resourceUri`; `open_canvas` answers in text only.
   */
  read?(): Promise<{
    uri: string;
    mimeType: string;
    text: string;
    _meta?: Record<string, unknown>;
  }>;
  /** The web canvas address of one session, for clients without views. */
  webLink(sessionId: string): string;
};

/** The canvas's MCP Apps resource URI; `open_canvas` names it. */
export const CANVAS_RESOURCE_URI = "ui://autograph/canvas";

export const WORK_SESSION_MCP_INSTRUCTIONS =
  "When the person asks for a new canvas, you may start one for them with create_session. When the person has no canvas yet, offer them two or three starting canvases (for example a chart of a model by an option column, totals of a money column, a graph following a link) and create the one they pick: create_session, then describe_workspace and add_unit for its units. Work in a canvas session: read records and aggregates through the session, stage values, propose changes in threads, manage your own rules and arrange the canvas's grids, charts and graphs. A human reviews the staged changes and Saves; you cannot Save, but you may ask them to with request_save. For new records or CSV imports, propose_records and import_csv return a proposal only; give the person the JSON to paste into Claude proposal in the web Canvas. These tools do not save or stage new records. Name models and columns as describe_workspace does. Staging, unstaging, discarding, the as-of date and the canvas layout are last-write-wins and take no revision; other changes pass the revision you last read, and on revision_conflict you re-read the session and retry with its revision.";
/** The instructions' sentence when the server shows the canvas in the chat. */
export const OPEN_CANVAS_INSTRUCTION =
  "Call open_canvas when the person wants to see or work in the session.";

const openCanvasInput = z.object({
  session: z
    .string()
    .min(1)
    .max(200)
    .describe("The session to show: its session_id, or its title."),
});

/** The conversation identity for one MCP call: the route's id plus the MCP session, if any. */
export function mcpConversationId(conversationId: string, sessionId: string | undefined): string {
  return JSON.stringify([conversationId, sessionId ?? null]);
}

/** One MCP server exposing the work-session tools to a verified agent. */
export function createWorkSessionMcpServer(input: WorkSessionMcpInput): McpServer {
  const core = createWorkSessionToolCore(input.definition);
  const showsCanvas = input.canvas?.read !== undefined;
  const server = new McpServer(
    input.server ?? { name: "autograph-work-session", version: "1.0.0" },
    {
      capabilities: { tools: {}, ...(input.canvas?.read === undefined ? {} : { resources: {} }) },
      instructions:
        input.canvas === undefined
          ? WORK_SESSION_MCP_INSTRUCTIONS
          : `${WORK_SESSION_MCP_INSTRUCTIONS} ${OPEN_CANVAS_INSTRUCTION}`,
    },
  );
  if (input.canvas !== undefined) registerCanvas(server, input, input.canvas);
  for (const spec of core.tools) {
    server.registerTool(
      spec.id,
      {
        title: spec.label,
        description: spec.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(spec.inputSchema),
        annotations: { readOnlyHint: spec.capability === "read_only", destructiveHint: false },
        // A started session shows in the chat, as open_canvas shows one.
        ...(spec.id === "create_session" && showsCanvas
          ? {
              _meta: {
                ui: { resourceUri: CANVAS_RESOURCE_URI },
                "ui/resourceUri": CANVAS_RESOURCE_URI,
              },
            }
          : {}),
      },
      async (args, ctx) => {
        const result = await core.call(spec.id, args, {
          context: input.contextForTurn(randomUUID()),
          conversationId: mcpConversationId(input.conversationId, ctx.sessionId),
          // The JSON-RPC id keeps its type: `1` and `"1"` are different calls.
          callId: ctx.mcpReq.id,
        });
        const payload = result.ok ? result.data : result.error;
        if (spec.id === "create_session" && result.ok) {
          const created = result.data as { session_id: string; title: string; as_of: string };
          // The text stands alone for clients without views.
          const link =
            input.canvas === undefined
              ? ""
              : ` Open it on the web: ${input.canvas.webLink(created.session_id)}`;
          return {
            content: [
              {
                type: "text",
                text: `Started "${created.title}" (session ${created.session_id}), as of ${created.as_of}.${link}`,
              },
            ],
            structuredContent: { session_id: created.session_id },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          ...(result.ok ? {} : { isError: true }),
        };
      },
    );
  }
  return server;
}

/**
 * The canvas resource and `open_canvas`: the tool shows one session in the
 * chat (`_meta.ui.resourceUri`; `structuredContent` names the session for
 * the canvas) and its text stands alone for clients without views. The
 * canvas itself signs in as the person; nothing here carries a token.
 */
function registerCanvas(
  server: McpServer,
  input: WorkSessionMcpInput,
  canvas: WorkSessionMcpCanvas,
) {
  const read = canvas.read;
  if (read !== undefined)
    server.registerResource(
      "canvas",
      CANVAS_RESOURCE_URI,
      {
        title: "Canvas",
        description: "The working-session canvas, acting as the signed-in person.",
        mimeType: "text/html;profile=mcp-app",
      },
      async () => ({ contents: [await read()] }),
    );
  server.registerTool(
    "open_canvas",
    {
      title: "Opening the canvas",
      description:
        "Show a working session's canvas in the chat, where the person edits, Saves and reviews as themselves. Name the session by id or title.",
      inputSchema: openCanvasInput,
      annotations: { readOnlyHint: true, destructiveHint: false },
      ...(read === undefined
        ? {}
        : {
            _meta: {
              ui: { resourceUri: CANVAS_RESOURCE_URI },
              "ui/resourceUri": CANVAS_RESOURCE_URI,
            },
          }),
    },
    async ({ session }) => {
      const work = createDataClient(
        input.definition,
        input.contextForTurn(randomUUID()),
      ).workSessions;
      const sessions = await work.request({ operation: "list" });
      const wanted = session.trim().toLowerCase();
      const titled = sessions.filter(
        (candidate) => candidate.title.trim().toLowerCase() === wanted,
      );
      const byId = sessions.find((candidate) => candidate.id === session.trim());
      // Several sessions share the title: never guess; the agent asks for the id.
      if (byId === undefined && titled.length > 1)
        return {
          content: [
            {
              type: "text",
              text: `${titled.length} active sessions are titled "${session}". Ask the person which one, then open it by its id from list_sessions.`,
            },
          ],
          isError: true,
        };
      const found = byId ?? titled[0];
      if (found === undefined)
        return {
          content: [
            {
              type: "text",
              text: `No active session is named "${session}". list_sessions lists them.`,
            },
          ],
          isError: true,
        };
      // The agent context reads staged entries in pages (never the whole overlay).
      let staged = 0;
      let after: WorkTarget | undefined;
      for (;;) {
        const page = await work.request({
          operation: "entries",
          session_id: found.id,
          limit: 1000,
          ...(after === undefined ? {} : { after }),
        });
        staged += page.entries.length;
        if (!page.has_more || page.next === null) break;
        after = page.next;
      }
      return {
        content: [
          {
            type: "text",
            text: `${found.title}, as of ${String(found.as_of).slice(0, 10)}: ${staged} staged ${
              staged === 1 ? "change" : "changes"
            }. Open it on the web: ${canvas.webLink(found.id)}`,
          },
        ],
        structuredContent: { session_id: found.id },
      };
    },
  );
}

/** A Streamable HTTP handler (web-standard fetch) for the app-mounted MCP route. */
export function createWorkSessionMcpHandler(input: WorkSessionMcpInput) {
  return createMcpHandler(() => createWorkSessionMcpServer(input));
}
