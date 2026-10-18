import { describe, expect, it } from "vitest";

import { escapeHtml, renderHtmlDocument } from "./html.js";

/**
 * The HTML document helper (Issue 212).
 *
 * What these are really checking is that nothing the caller passes can end the
 * element it was put inside. The CSP nonce protects a *script* from running
 * without permission; it does nothing about a title that closes its own tag
 * and opens a new one, and the policy cannot help there because the markup
 * came from the server and is therefore trusted by definition.
 */

describe("escapeHtml", () => {
  it("escapes every character that can end an attribute or an element", () => {
    expect(escapeHtml(`<script src="a'b">&</script>`)).toBe(
      "&lt;script src=&quot;a&#39;b&quot;&gt;&amp;&lt;/script&gt;",
    );
  });

  it("escapes an ampersand once, not twice", () => {
    // The order-of-replacement bug: escaping `&` last would turn the `&lt;`
    // produced for `<` into `&amp;lt;`, and a title reading
    // "&amp;lt;b&amp;gt;" is what a page looks like after someone gets this
    // wrong.
    expect(escapeHtml("<&")).toBe("&lt;&amp;");
  });
});

describe("renderHtmlDocument", () => {
  const base = { title: "Docs", body: "<p>hello</p>", cspNonce: "abc123" };

  it("emits a document that carries its own charset and language", () => {
    const html = renderHtmlDocument(base);

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<p>hello</p>");
  });

  it("escapes the title, which is the one field that came from somewhere else", () => {
    const html = renderHtmlDocument({
      ...base,
      title: '</title><script>alert("x")</script>',
    });

    expect(html).not.toContain("<title></title>");
    expect(html).toContain("&lt;/title&gt;");
    // Only the inline script we authored may appear.
    expect(html).not.toContain("<script");
  });

  it("omits any script element when there is no inline script to run", () => {
    expect(renderHtmlDocument(base)).not.toContain("<script");
  });

  it("carries the CSP nonce on the inline script it emits", () => {
    const html = renderHtmlDocument({ ...base, inlineScript: "console.log(1);" });

    // Without the nonce, this script is blocked by the policy in
    // `plugins/security-headers.ts` — the document would render and silently
    // not work.
    expect(html).toContain('<script nonce="abc123">console.log(1);</script>');
  });

  it("cannot be escaped out of by a value that is not markup", () => {
    const html = renderHtmlDocument({
      cspNonce: `a" onerror="x`,
      title: "Docs",
      body: "<p>hello</p>",
      inlineScript: "void 0;",
    });

    // A nonce is generated, not supplied, so this is defence in depth against
    // the day someone threads it from a header or a query parameter.
    expect(html).not.toContain('nonce="a" onerror="x"');
    expect(html).toContain('nonce="a&quot; onerror=&quot;x"');
  });

  it("does not let authored script text close its own element", () => {
    const html = renderHtmlDocument({
      ...base,
      inlineScript: `const docs = "</script><img src=x onerror=alert(1)>";`,
    });

    // Inside `<script>` the only way out is the `</script` sequence, and HTML
    // entity escaping does not work there — so the sequence itself is broken
    // up. The replacement is valid JavaScript and cannot terminate the element.
    expect(html).not.toContain('</script><img');
    expect(html).toContain("<\\/script>");
  });
});
