import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { formatScopes, SCOPES } from "@/lib/oauth/config";

/**
 * Dynamic client registration (RFC 7591), open to anyone: a client that
 * registers gets nothing until a signed-in workspace manager approves it on
 * the consent page. Clients are public, authenticate with PKCE alone, and are
 * told so whatever authentication method they asked for (RFC 7591 lets the
 * server substitute values it does not support).
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Schemes a redirect may never use, even by a native app.
const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "about:",
  "blob:",
  "ftp:",
  "ws:",
  "wss:",
]);

function isLoopback(url: URL) {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Where an authorization code may be sent: an https URL, http only on a
 * loopback address (CLI clients such as Claude Code), or a native app's own
 * scheme. Never a fragment (RFC 6749 §3.1.2).
 */
function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes("#")) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  if (url.protocol === "http:") return isLoopback(url);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/**
 * Whether a redirect_uri in a request is one the client registered. Exact
 * match, except that a loopback redirect may use any port (RFC 8252 §7.3), as
 * native clients pick a free port each time.
 */
export function matchesRegisteredRedirectUri(
  registered: readonly string[],
  candidate: string
): boolean {
  if (registered.includes(candidate)) return true;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (!isLoopback(url)) return false;
  return registered.some((entry) => {
    const known = new URL(entry);
    return (
      isLoopback(known) &&
      known.hostname === url.hostname &&
      known.pathname === url.pathname &&
      known.search === url.search
    );
  });
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});

const GRANT_TYPES = ["authorization_code", "refresh_token"];

export type RegistrationResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string; description: string };

export async function registerClient(metadata: unknown): Promise<RegistrationResult> {
  const parsed = registrationSchema.safeParse(metadata);
  if (!parsed.success) {
    const redirectProblem = parsed.error.issues.some(
      (issue) => issue.path[0] === "redirect_uris"
    );
    return {
      ok: false,
      error: redirectProblem ? "invalid_redirect_uri" : "invalid_client_metadata",
      description: redirectProblem
        ? "redirect_uris must list between 1 and 10 URIs"
        : "The client metadata is not valid",
    };
  }

  const { redirect_uris, client_name, grant_types, response_types } = parsed.data;
  const badUri = redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
  if (badUri !== undefined) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description:
        "Redirect URIs must be https, http on localhost, or an app's own scheme, without a fragment",
    };
  }
  if (grant_types?.some((grant) => !GRANT_TYPES.includes(grant))) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "Only the authorization_code and refresh_token grants are supported",
    };
  }
  if (response_types?.some((type) => type !== "code")) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "Only the code response type is supported",
    };
  }

  const [, client] = await prisma.$transaction([
    // Housekeeping: anyone may register, so a client that 30 days on has
    // neither a connection nor an authorization code goes.
    prisma.oAuthClient.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) },
        connections: { none: {} },
        authorizationCodes: { none: {} },
      },
    }),
    prisma.oAuthClient.create({
      data: {
        name: client_name?.trim() || "Unnamed app",
        redirectUris: redirect_uris,
      },
    }),
  ]);

  return {
    ok: true,
    body: {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: GRANT_TYPES,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: formatScopes(SCOPES),
    },
  };
}

export function findClient(clientId: string | null | undefined) {
  if (!clientId) return Promise.resolve(null);
  return prisma.oAuthClient.findUnique({ where: { id: clientId } });
}
