import { getBaseUrl } from "@/lib/env";

/**
 * OpenReply's OAuth authorization server for its MCP endpoint. Every URL is
 * derived from NEXTAUTH_URL, the deployment's existing public URL, so the
 * connector needs no configuration of its own.
 */

/** What a connection may do. `read` is always granted. */
export const SCOPES = ["read", "campaigns:write", "messages:send"] as const;
export type Scope = (typeof SCOPES)[number];

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// Sliding: every refresh issues a new refresh token with a fresh lifetime, so
// a connection in regular use never expires.
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
// How long after its first use a refresh token can be used again: a client
// whose access token runs out during parallel calls refreshes from each of
// them with the same refresh token.
export const REFRESH_REUSE_GRACE_SECONDS = 30;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

/** The known scopes among `values`, in canonical order, unknown ones dropped. */
export function knownScopes(values: readonly string[]): Scope[] {
  return SCOPES.filter((scope) => values.includes(scope));
}

/** The scopes in a space-separated list, in canonical order, unknown ones dropped. */
export function parseScopes(value: string | null | undefined): Scope[] {
  return knownScopes((value ?? "").split(/\s+/));
}

export function formatScopes(scopes: readonly string[]): string {
  return knownScopes(scopes).join(" ");
}

export function issuer(): string {
  return new URL(getBaseUrl()).origin;
}

/** The MCP endpoint's resource identifier, which is also its URL. */
export function mcpResourceUrl(): string {
  return `${issuer()}/api/mcp`;
}

/** RFC 9728 metadata for the MCP endpoint, at its path-inserted well-known URL. */
export function protectedResourceMetadataUrl(): string {
  return `${issuer()}/.well-known/oauth-protected-resource/api/mcp`;
}

export const OAUTH_PATHS = {
  authorize: "/api/oauth/authorize",
  token: "/api/oauth/token",
  register: "/api/oauth/register",
  consent: "/oauth/consent",
} as const;
