// Bracketed-paste markers — DECSET 2004. Agent TUIs (Claude Code, etc.) turn
// on bracketed-paste mode, which makes them treat everything between these
// markers as a single paste: embedded newlines stay literal instead of
// submitting the input.
//
// Sending a multi-line prompt as raw PTY input WITHOUT these markers lets the
// first '\n' submit the prompt, truncating everything after it. Whether that
// happens is a race — Claude's TUI keeps a paste intact only when the whole
// block arrives in one PTY read, so longer prompts / slower agent startup make
// it "sometimes" cut the text off. Wrapping in bracketed paste removes the
// race entirely; we then send Enter separately to submit.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Send a (possibly multi-line) prompt to an agent terminal.
 *
 * The text is delivered as a bracketed paste so embedded newlines are kept as
 * literal newlines instead of submitting early. By default Enter is then sent
 * as a separate write to submit; pass `{ submit: false }` to leave the text in
 * the input for the user to review/edit before submitting themselves (e.g.
 * skill prompts).
 */
export function sendAgentPrompt(
  terminalId: string,
  prompt: string,
  opts: { submit?: boolean; submitDelayMs?: number } = {},
): void {
  const { submit = true, submitDelayMs = 80 } = opts;
  window.electronAPI.sendTerminalInput(
    terminalId,
    BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END,
  );
  if (!submit) return;
  // Submit as a separate write so the paste finishes before Enter arrives.
  setTimeout(() => {
    window.electronAPI.sendTerminalInput(terminalId, '\r');
  }, submitDelayMs);
}
