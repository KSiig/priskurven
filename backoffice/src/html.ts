/**
 * Tiny HTML helper used by the backoffice shell.
 *
 * `escapeHtml` is intentionally minimal: it covers the four characters
 * that can break out of an HTML text node or an attribute value
 * delimited by `"`. The backoffice shell interpolates one piece of
 * user-controlled data — the email returned by Cloudflare Access —
 * and we want a name that's safe to drop into a string literal.
 *
 * No template engine, no DOM dependency: this file is reachable from
 * the worker bundle and the test bundle without any polyfill.
 */

/**
 * Escape `&`, `<`, `>`, and `"` so the returned string is safe to
 * splice into an HTML text node or a double-quoted attribute value.
 * Apostrophes are NOT escaped: the shell does not use single-quoted
 * attributes, and the Access email shape never contains them, but if
 * that ever changes, add `'` here.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}