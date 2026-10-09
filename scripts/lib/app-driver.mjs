/**
 * Drives the running Next.js app over HTTP, the way a browser with JavaScript
 * disabled does.
 *
 * Next renders progressive-enhancement fields into every `<form action={...}>`
 * -- `$ACTION_REF_*`, `$ACTION_*:0`, `$ACTION_*:1`, `$ACTION_KEY` -- which
 * together name the Server Action and carry its bound arguments. Replaying a
 * form with those fields intact invokes the REAL action: real session cookies,
 * real authorisation, real database writes.
 *
 * That matters for verifying the audit log. Most audit entries are written by
 * `logAudit()` inside a Server Action, so a test that talked to Postgres
 * directly would be re-implementing the thing it is meant to be checking.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";

/* -------------------------------------------------------------------------- */
/* A minimal cookie jar                                                        */
/* -------------------------------------------------------------------------- */

export function createSession() {
  return { cookies: new Map() };
}

function cookieHeader(session) {
  return [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbCookies(session, response) {
  // getSetCookie keeps multiple Set-Cookie headers separate, which matters:
  // Supabase chunks large sessions across several cookies.
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === "" || /expires=thu, 01 jan 1970/i.test(line)) session.cookies.delete(name);
    else session.cookies.set(name, value);
  }
}

export async function get(session, path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie: cookieHeader(session) },
    redirect: "manual",
  });
  absorbCookies(session, response);
  const body = response.status < 300 || response.status >= 400 ? await response.text() : "";
  return { status: response.status, location: response.headers.get("location"), body };
}

/* -------------------------------------------------------------------------- */
/* Form parsing                                                                */
/* -------------------------------------------------------------------------- */

const FORM_RE = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
const INPUT_RE = /<(input|select|textarea)\b([^>]*)>/gi;
const ATTR_RE = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;

function attrs(tag) {
  const out = {};
  let match;
  while ((match = ATTR_RE.exec(tag)) !== null) out[match[1].toLowerCase()] = match[2];
  ATTR_RE.lastIndex = 0;
  return out;
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Every form on the page, with the hidden Server Action fields it carries.
 * `marker` picks a specific one: a substring that appears inside that form.
 */
export function findForms(html) {
  const forms = [];
  let match;
  while ((match = FORM_RE.exec(html)) !== null) {
    const inner = match[1];
    const hidden = {};

    let field;
    while ((field = INPUT_RE.exec(inner)) !== null) {
      const a = attrs(field[2]);
      if (!a.name) continue;
      if (a.type === "hidden") hidden[a.name] = decodeEntities(a.value ?? "");
    }
    INPUT_RE.lastIndex = 0;

    forms.push({ html: inner, hidden });
  }
  FORM_RE.lastIndex = 0;
  return forms;
}

/**
 * The first form on the page matching `marker`.
 *
 * `marker` may be an array, in which case EVERY entry must appear in the form.
 * That matters more than it looks: several pages render a "save" form and an
 * "archive" form side by side that share a hidden id field, so a single marker
 * silently picks the wrong one and submits the wrong action.
 */
export function pickForm(html, marker) {
  const markers = marker == null ? [] : Array.isArray(marker) ? marker : [marker];
  const forms = findForms(html);
  const found =
    markers.length === 0
      ? forms[0]
      : forms.find((f) => markers.every((m) => f.html.includes(m)));
  if (!found) {
    throw new Error(`No form found matching ${JSON.stringify(markers)}`);
  }
  if (!Object.keys(found.hidden).some((k) => k.startsWith("$ACTION"))) {
    throw new Error(`Form matching ${JSON.stringify(markers)} carries no Server Action fields`);
  }
  return found;
}

/**
 * Submit a form: its hidden action fields, plus the values given.
 * `fields` may repeat a name by passing an array, for checkbox groups.
 */
export async function submit(session, path, form, fields = {}) {
  const body = new FormData();
  for (const [name, value] of Object.entries(form.hidden)) {
    // A hidden field the caller is also supplying is theirs to set -- several
    // forms render an empty hidden input that client JavaScript fills in
    // (the POS basket, the consent responses, the signature).
    if (name in fields) continue;
    body.append(name, value);
  }
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) body.append(name, String(v));
    else body.append(name, String(value));
  }

  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie: cookieHeader(session) },
    body,
    redirect: "manual",
  });
  absorbCookies(session, response);

  return {
    status: response.status,
    location: response.headers.get("location"),
    text: await response.text(),
  };
}

/** Fetch a page and submit one of its forms in a single step. */
export async function act(session, path, marker, fields = {}) {
  const page = await get(session, path);
  if (page.status >= 300 && page.status < 400) {
    // A redirect means the page never rendered -- almost always the session
    // being bounced to /login. Say so, rather than reporting "no form found".
    throw new Error(`GET ${path} redirected to ${page.location} (status ${page.status})`);
  }
  if (page.status >= 400) throw new Error(`GET ${path} returned ${page.status}`);
  const form = pickForm(page.body, marker);
  return submit(session, path, form, fields);
}

/** Sign in through the real login form, leaving the session holding cookies. */
export async function signIn(session, email, password) {
  const result = await act(session, "/login", 'name="email"', { email, password });
  const signedIn = [...session.cookies.keys()].some((name) => name.includes("auth-token"));
  if (!signedIn) throw new Error(`Sign in failed for ${email} (status ${result.status})`);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Server Actions that are not attached to a form                              */
/* -------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";

let manifest = null;

/**
 * The runtime id of a Server Action, by its exported name.
 *
 * Next writes this mapping out at build time. It is what lets the test reach an
 * action that is called from a client component rather than submitted by a
 * form -- otherwise such an action is simply unreachable from here, and would
 * have to be taken on trust.
 */
export function actionId(exportedName) {
  manifest ??= JSON.parse(
    readFileSync(".next/server/server-reference-manifest.json", "utf8"),
  );

  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    if (entry.exportedName === exportedName) return id;
  }
  throw new Error(
    `No Server Action named ${exportedName} in the build manifest. Run "npm run build" first.`,
  );
}

/**
 * Invoke a Server Action directly, the way the React client does: a POST to a
 * page that hosts it, naming the action in the `Next-Action` header and
 * carrying its arguments as a JSON array.
 */
export async function callAction(session, path, exportedName, args = []) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(session),
      "Next-Action": actionId(exportedName),
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  absorbCookies(session, response);
  const text = await response.text();

  if (response.status === 404 && text.includes("Server action not found")) {
    // The ids are content hashes. An incremental build can leave the manifest
    // on disk out of step with the server that is running, and the symptom is
    // an unhelpful 404 rather than anything about staleness.
    throw new Error(
      `The running server does not recognise ${exportedName}. The build manifest is stale -- ` +
        "rebuild from clean (rm -rf .next && npm run build) and restart the app.",
    );
  }

  return { status: response.status, text };
}

/**
 * Refuse to run against a server built from different code.
 *
 * Server Action ids are content hashes, so a server started before the last
 * build simply does not recognise the ids in the manifest on disk. The symptom
 * is a form that posts and silently does nothing -- no error, no effect --
 * which is a miserable thing to debug and has cost real time twice.
 *
 * This turns it into a sentence.
 */
export async function assertFreshBuild() {
  const id = actionId("signInAction");

  const response = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8" },
    body: "[]",
    redirect: "manual",
  });

  const text = await response.text();
  if (response.status === 404 && text.includes("Server action not found")) {
    throw new Error(
      "The running app was built from different code than the manifest on disk.\n" +
        "  Stop the server, run `npm run build`, then `npm run start` again.\n" +
        "  (On Windows the old server often keeps port 3000 and the new one exits silently.)",
    );
  }
}
