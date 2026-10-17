import type { OAuthClient } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  issuer,
  parseScopes,
  SCOPES,
  type Scope,
} from "@/lib/oauth/config";
import { findClient, matchesRegisteredRedirectUri } from "@/lib/oauth/clients";
import { generateSecret, hashSecret, isS256Challenge } from "@/lib/oauth/secrets";

/**
 * The authorization request: what the authorize endpoint and the consent page
 * check before anyone is asked to approve anything, and the code an approval
 * produces.
 */

/** The parameters of an authorization request that the consent form carries. */
export const AUTHORIZATION_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

export type AuthorizationRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  /** What the consent page offers; `read` is always among them. */
  scopes: Scope[];
  codeChallenge: string;
};

export type AuthorizationCheck =
  | { ok: true; request: AuthorizationRequest }
  // The client or its redirect URI cannot be trusted, so the error is shown
  // here and nobody is redirected anywhere (RFC 6749 §4.1.2.1).
  | { ok: false; redirectTo: null; error: string; description: string }
  // Anything else goes back to the client as an error response.
  | { ok: false; redirectTo: string; error: string; description: string };

/** The client's redirect URI with an authorization response added to it. */
export function authorizationResponseUrl(
  redirectUri: string,
  params: Record<string, string>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // RFC 9207, so a client talking to several servers can tell who answered.
  url.searchParams.set("iss", issuer());
  return url.toString();
}

function sameOrigin(value: string) {
  try {
    return new URL(value).origin === issuer();
  } catch {
    return false;
  }
}

export async function checkAuthorizationRequest(
  params: URLSearchParams
): Promise<AuthorizationCheck> {
  const client = await findClient(params.get("client_id"));
  if (!client) {
    return {
      ok: false,
      redirectTo: null,
      error: "invalid_client",
      description: "This app is not registered with OpenReply.",
    };
  }

  const requestedRedirect = params.get("redirect_uri");
  const redirectUri =
    requestedRedirect ??
    (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (
    !redirectUri ||
    !matchesRegisteredRedirectUri(client.redirectUris, redirectUri)
  ) {
    return {
      ok: false,
      redirectTo: null,
      error: "invalid_request",
      description: "The redirect URI does not match the one this app registered.",
    };
  }

  const state = params.get("state") ?? "";
  const refuse = (error: string, description: string): AuthorizationCheck => ({
    ok: false,
    redirectTo: authorizationResponseUrl(redirectUri, {
      error,
      error_description: description,
      ...(state ? { state } : {}),
    }),
    error,
    description,
  });

  if (params.get("response_type") !== "code") {
    return refuse("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!state || state.length > 2048) {
    return refuse("invalid_request", "A state parameter is required");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !isS256Challenge(codeChallenge)) {
    return refuse("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const resource = params.get("resource");
  if (resource !== null && !sameOrigin(resource)) {
    return refuse("invalid_target", "The resource is not served by this OpenReply");
  }

  // Unknown scopes are ignored and `read` is always included. Asking for none
  // offers everything, which is what the Claude app does.
  const requested = parseScopes(params.get("scope"));
  const scopes = requested.length === 0 ? [...SCOPES] : requested;
  if (!scopes.includes("read")) scopes.unshift("read");

  return {
    ok: true,
    request: { client, redirectUri, state, scopes, codeChallenge },
  };
}

/** The scopes an approval grants: those offered and ticked, always with `read`. */
export function grantedScopes(offered: Scope[], ticked: string[]): Scope[] {
  return offered.filter((scope) => scope === "read" || ticked.includes(scope));
}

export async function issueAuthorizationCode({
  request,
  userId,
  workspaceId,
  scopes,
}: {
  request: AuthorizationRequest;
  userId: string;
  workspaceId: string;
  scopes: Scope[];
}): Promise<string> {
  const code = generateSecret("orc");
  const now = Date.now();
  await prisma.$transaction([
    // Housekeeping: codes are worthless a day after they expire.
    prisma.oAuthAuthorizationCode.deleteMany({
      where: { expiresAt: { lt: new Date(now - 86_400_000) } },
    }),
    prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: hashSecret(code),
        clientId: request.client.id,
        userId,
        workspaceId,
        scopes,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        expiresAt: new Date(now + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
      },
    }),
  ]);
  return code;
}
