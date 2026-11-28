/**
 * Builds HTML responses with a CSP nonce applied by the same code that renders the document, so a
 * future page cannot undo the policy in `plugins/security-headers.ts` with an inline script. `body`
 * must be markup authored in this repository; escape any user-supplied content at its own boundary.
 */

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

export function escapeHtml(value: string): string {
  // `&` first, by construction: escaping in any other order re-escapes the
  // ampersands the earlier replacements introduced.
  return value.replace(/[&<>"']/gu, (character) => ESCAPES.get(character) ?? character);
}

export interface RenderHtmlDocumentInput {
  readonly title: string;
  readonly body: string;
  /** From `request.cspNonce`; the policy permits no other inline script. */
  readonly cspNonce: string;
  /**
   * JavaScript to run once the document is loaded.
   *
   * Optional because most pages need none, and a page that does need it is the
   * case this function exists to make safe.
   */
  readonly inlineScript?: string;
}

/**
 * A complete HTML document, with the CSP nonce threaded into its one inline
 * script.
 *
 * The nonce is emitted in one place only. Every other route that wants HTML
 * should call this rather than build a string, so that "which responses carry
 * executable inline script" stays a question with one answer.
 */
export function renderHtmlDocument(input: RenderHtmlDocumentInput): string {
  const { cspNonce, title, body } = input;
  const script =
    input.inlineScript === undefined
      ? ""
      : // The script *text* is not escaped: inside `<script>` an HTML entity is
        // not decoded, so escaping would change the program rather than protect
        // it. What protects it is the nonce, and the fact that the text is
        // ours. `</script>` in authored content is a real hazard though, and
        // the sequence is what closes it.
        `<script nonce="${escapeHtml(cspNonce)}">${input.inlineScript.replaceAll(
          "</script",
          "<\\/script",
        )}</script>\n`;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    body,
    script,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
