/**
 * The HTML seam for surfaces served by this API (Issue 212).
 *
 * The API answers in JSON, so nothing renders HTML yet. This exists ahead of
 * the Swagger UI of Issue 237 and whatever admin page follows, for one reason:
 * a nonce is only worth having if the thing that renders the document is the
 * thing that receives it. A page builder written later, under time pressure,
 * will reach for `inline: true` in a template helper or a `<script>` written by
 * hand, and the policy in `plugins/security-headers.ts` will have been undone
 * at the point of contact — invisibly, because the response header still looks
 * correct.
 *
 * `body` is markup this repository authored, not data. Anything user-supplied
 * has to be escaped at its own boundary, where the rules of that content are
 * known; a generic "render a page" helper cannot guess whether a markdown
 * renderer has already sanitized.
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
