// The canvas in a chat keeps the design system's own palette: the host's
// colours, radii and shadows never replace our tokens, so the frame looks the
// same as the web canvas whatever the host page around it. Only the host's
// fonts apply (its font stacks and font faces, never inlined ones). The design
// system defines a light theme only, so the frame stays light even in a dark
// host: it declares `data-theme="light"` and a light `color-scheme`, so native
// controls and scrollbars match the cards around them.
import { applyHostFonts, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";

/** The host style variables the frame takes: its font stacks, which share our token names. */
const hostFontVariables = ["--font-sans", "--font-mono"] as const;

/** Applies one host context (or its change) to the document. */
export function applyHostTheme(
  context: Pick<McpUiHostContext, "theme" | "styles">,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = "light";
  root.style.colorScheme = "light";
  const variables = context.styles?.variables as Record<string, string | undefined> | undefined;
  if (variables)
    for (const name of hostFontVariables) {
      const value = variables[name];
      if (typeof value === "string" && value.trim() !== "") root.style.setProperty(name, value);
    }
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
