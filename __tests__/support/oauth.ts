/**
 * The OAuth handshake a client such as the Claude app makes, as plain
 * requests to the app's own route handlers. Suites that import this must
 * also install the database and session fakes.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { expect } from "vitest";
import { GET as authorize } from "@/app/api/oauth/authorize/route";
import { POST as consent } from "@/app/api/oauth/consent/route";
import { POST as register } from "@/app/api/oauth/register/route";
import { POST as token } from "@/app/api/oauth/token/route";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { signInAs } from "./session";

export const BASE_URL = "https://openreply.test";
export const MCP_URL = `${BASE_URL}/api/mcp`;
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const ALL_SCOPES = ["read", "campaigns:write", "messages:send"];

// Every OAuth and MCP URL derives from the deployment's public URL.
process.env.NEXTAUTH_URL = BASE_URL;

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function registerRequest(metadata: unknown) {
  return register(
    new Request(`${BASE_URL}/api/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof metadata === "string" ? metadata : JSON.stringify(metadata),
    })
  );
}

export async function registerClient(
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const res = await registerRequest({
    client_name: "Claude",
    redirect_uris: [CLAUDE_REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...metadata,
  });
  expect(res.status).toBe(201);
  return (await res.json()).client_id;
}

export function authorizationParams({
  clientId,
  challenge,
  redirectUri = CLAUDE_REDIRECT,
  scope = ALL_SCOPES.join(" "),
  state = "state-123",
}: {
  clientId: string;
  challenge: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  });
}

export function authorizeRequest(params: URLSearchParams) {
  return authorize(new NextRequest(`${BASE_URL}/api/oauth/authorize?${params}`));
}

/** The consent page's form, submitted from the consent page itself. */
export function consentRequest(
  params: URLSearchParams,
  {
    decision = "allow",
    grants = ALL_SCOPES,
    headers = {},
  }: { decision?: string; grants?: string[]; headers?: Record<string, string> } = {}
) {
  const form = new URLSearchParams(params);
  form.set("decision", decision);
  for (const grant of grants) form.append("grant", grant);
  return consent(
    new NextRequest(`${BASE_URL}/api/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: BASE_URL,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Dest": "document",
        ...headers,
      },
      body: form.toString(),
    })
  );
}

export function tokenRequest(params: Record<string, string>) {
  return token(
    new Request(`${BASE_URL}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    })
  );
}

/** The code from a consent response's redirect back to the client. */
export function codeFrom(res: Response): string {
  const location = res.headers.get("location");
  expect(location, "consent should redirect back to the client").toBeTruthy();
  const code = new URL(location!).searchParams.get("code");
  expect(code, location!).toBeTruthy();
  return code!;
}

/** Signs in as the person and approves a code for the client. */
export async function approve({
  userId,
  clientId,
  grants = ALL_SCOPES,
}: {
  userId: string;
  clientId: string;
  grants?: string[];
}) {
  signInAs(userId);
  const { verifier, challenge } = pkce();
  const params = authorizationParams({ clientId, challenge });
  const res = await consentRequest(params, { grants });
  expect(res.status).toBe(303);
  return { code: codeFrom(res), verifier };
}

export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

/** A whole connection: register, approve and exchange, as the Claude app does. */
export async function connect({
  userId,
  grants = ALL_SCOPES,
  clientId,
}: {
  userId: string;
  grants?: string[];
  clientId?: string;
}): Promise<Tokens & { clientId: string }> {
  const client = clientId ?? (await registerClient());
  const { code, verifier } = await approve({ userId, clientId: client, grants });
  const res = await tokenRequest({
    grant_type: "authorization_code",
    client_id: client,
    code,
    redirect_uri: CLAUDE_REDIRECT,
    code_verifier: verifier,
    resource: MCP_URL,
  });
  expect(res.status).toBe(200);
  return { ...((await res.json()) as Tokens), clientId: client };
}

/** A bare MCP initialize request, to see whether a token is accepted. */
export function mcpInitialize(authorization?: string) {
  return handleMcpRequest(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "1.0.0" },
        },
      }),
    })
  );
}
