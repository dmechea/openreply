import {
  issuer,
  mcpResourceUrl,
  OAUTH_PATHS,
  protectedResourceMetadataUrl,
  SCOPES,
} from "@/lib/oauth/config";

// The discovery, registration and token endpoints answer browser-based
// clients too (such as the MCP Inspector). They take no cookies, so allowing
// any origin exposes nothing.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

export function oauthJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

export function oauthError(error: string, description: string, status = 400): Response {
  return oauthJson({ error, error_description: description }, status);
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** RFC 9728 metadata for the MCP endpoint. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "OpenReply",
  };
}

/** RFC 8414 metadata for OpenReply's authorization server. */
export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${base}${OAUTH_PATHS.token}`,
    registration_endpoint: `${base}${OAUTH_PATHS.register}`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * The challenge on a 401 from the MCP endpoint, pointing the client at the
 * metadata that tells it where to sign in (RFC 9728 §5.1).
 */
export function bearerChallenge(invalidToken: boolean): string {
  const parts = [
    ...(invalidToken
      ? ['error="invalid_token"', 'error_description="The access token is missing, expired or revoked"']
      : []),
    `resource_metadata="${protectedResourceMetadataUrl()}"`,
    `scope="${SCOPES.join(" ")}"`,
  ];
  return `Bearer ${parts.join(", ")}`;
}
