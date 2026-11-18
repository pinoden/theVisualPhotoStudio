/**
 * The website editor's phone check asks for a page as it will be once one
 * document is published (src/components/site-editor/phone-check.ts): the
 * page's address with `?website-check=design`, `frame` or `page`. In a
 * preview, the page then shows that document's draft and everything else as
 * it is published, where an ordinary preview shows every draft
 * (src/server/site.ts). A layout cannot read a page's query, so the proxy
 * (src/proxy.ts) hands it on as a request header.
 *
 * `page` is the page editor's check: its route draws the page's draft by
 * itself, and the design and the header, menu and footer as published.
 * `published` shows no draft at all: what visitors have now, to tell a
 * problem a change brings from one a page had before it.
 */
export const WEBSITE_CHECK_PARAM = "website-check";
export const WEBSITE_CHECK_HEADER = "x-website-check";

export const CHECK_SCOPES = ["design", "frame", "page", "published"] as const;
export type CheckScope = (typeof CHECK_SCOPES)[number];

export const isCheckScope = (value: unknown): value is CheckScope => typeof value === "string" && (CHECK_SCOPES as readonly string[]).includes(value);
