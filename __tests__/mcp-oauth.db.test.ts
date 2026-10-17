/**
 * The OAuth handshake that connects the Claude app to OpenReply, end to end
 * as plain requests against a real Postgres: discovery, registration,
 * authorize, consent, the PKCE code exchange, refresh rotation, revoking a
 * connection from Settings, and the MCP endpoint refusing what it should.
 * Needs TEST_DATABASE_URL; see docs/testing.md.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTestDatabase, openTestDatabase, type TestDatabase } from "./support/database";
import { signInAs, signOut } from "./support/session";
import { addMember, createOwner } from "./support/fixtures";
import {
  ALL_SCOPES,
  approve,
  authorizationParams,
  authorizeRequest,
  BASE_URL,
  CLAUDE_REDIRECT,
  codeFrom,
  connect,
  consentRequest,
  MCP_URL,
  mcpInitialize,
  pkce,
  registerClient,
  registerRequest,
  tokenRequest,
} from "./support/oauth";

vi.mock("@/lib/db/client", async () => (await import("./support/database")).prismaModule);
vi.mock("@/lib/auth", async () => (await import("./support/session")).authModule);

import { GET as rootResourceMetadata } from "../app/.well-known/oauth-protected-resource/route";
import { GET as resourceMetadata } from "../app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as serverMetadata } from "../app/.well-known/oauth-authorization-server/route";
import {
  DELETE as revokeConnection,
  GET as listConnections,
} from "../app/api/oauth/connections/route";

let db: TestDatabase;
let ownerId = "";
let workspaceId = "";

const RESOURCE_METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/api/mcp`;

function exchange(clientId: string, code: string, verifier: string, redirectUri = CLAUDE_REDIRECT) {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: MCP_URL,
  });
}

function refresh(clientId: string, refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
}

async function connectionsList() {
  const res = await listConnections();
  return { status: res.status, body: await res.json() };
}

function revoke(id: string) {
  return revokeConnection(
    new NextRequest(`${BASE_URL}/api/oauth/connections?id=${id}`, { method: "DELETE" })
  );
}

describe.skipIf(!hasTestDatabase)("connecting the Claude app over OAuth", () => {
  beforeAll(async () => {
    db = await openTestDatabase("mcp_oauth");
    const owner = await createOwner(db.prisma, "creator");
    ownerId = owner.user.id;
    workspaceId = owner.workspace.id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(() => {
    signOut();
  });

  describe("discovery", () => {
    it("serves the MCP endpoint's protected-resource metadata at both well-known URLs", async () => {
      for (const res of [resourceMetadata(), rootResourceMetadata()]) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          resource: MCP_URL,
          authorization_servers: [BASE_URL],
          scopes_supported: ALL_SCOPES,
          bearer_methods_supported: ["header"],
          resource_name: "OpenReply",
        });
      }
    });

    it("serves the authorization server's metadata", async () => {
      const res = serverMetadata();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/api/oauth/authorize`,
        token_endpoint: `${BASE_URL}/api/oauth/token`,
        registration_endpoint: `${BASE_URL}/api/oauth/register`,
        scopes_supported: ALL_SCOPES,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    });

    it("points an unauthenticated MCP request at the metadata", async () => {
      const res = await mcpInitialize();
      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
      expect(challenge).not.toContain("invalid_token");
    });
  });

  describe("dynamic client registration", () => {
    it("registers a public client and stores its redirect URIs", async () => {
      const res = await registerRequest({
        client_name: "Claude",
        redirect_uris: [CLAUDE_REDIRECT],
        token_endpoint_auth_method: "client_secret_basic",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        client_name: "Claude",
        redirect_uris: [CLAUDE_REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
      expect(body.client_secret).toBeUndefined();
      const stored = await db.prisma.oAuthClient.findUniqueOrThrow({ where: { id: body.client_id } });
      expect(stored.redirectUris).toEqual([CLAUDE_REDIRECT]);
    });

    it.each([
      ["no redirect URIs", { client_name: "x" }],
      ["an http redirect off localhost", { redirect_uris: ["http://evil.example/cb"] }],
      ["a javascript: redirect", { redirect_uris: ["javascript:alert(1)"] }],
      ["a redirect with a fragment", { redirect_uris: ["https://claude.ai/cb#x"] }],
      ["an unsupported grant", { redirect_uris: [CLAUDE_REDIRECT], grant_types: ["client_credentials"] }],
      ["an unsupported response type", { redirect_uris: [CLAUDE_REDIRECT], response_types: ["token"] }],
    ])("refuses %s", async (_case, metadata) => {
      const res = await registerRequest(metadata);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^invalid_(redirect_uri|client_metadata)$/);
    });

    it("refuses a body that is not JSON", async () => {
      const res = await registerRequest("redirect_uris=nope");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_client_metadata");
    });

    it("accepts a loopback redirect and a native app's own scheme", async () => {
      for (const uri of ["http://localhost:33418/callback", "http://127.0.0.1:5555/cb", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
        expect((await registerRequest({ redirect_uris: [uri] })).status).toBe(201);
      }
    });
  });

  describe("authorize", () => {
    it("sends someone who is signed out to the magic-link sign-in and back", async () => {
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const res = await authorizeRequest(params);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(`${BASE_URL}/login`);
      expect(location.searchParams.get("callbackUrl")).toBe(`/api/oauth/authorize?${params}`);
    });

    it("takes someone who is signed in straight to the consent page", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const res = await authorizeRequest(params);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${BASE_URL}/oauth/consent?${params}`);
    });

    it("never redirects for an unknown client or an unregistered redirect URI", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const { challenge } = pkce();
      for (const params of [
        authorizationParams({ clientId: "not-a-client", challenge }),
        authorizationParams({ clientId, challenge, redirectUri: "https://evil.example/cb" }),
      ]) {
        const res = await authorizeRequest(params);
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
      }
    });

    it.each([
      ["no PKCE challenge", (p: URLSearchParams) => p.delete("code_challenge"), "invalid_request"],
      ["the plain PKCE method", (p: URLSearchParams) => p.set("code_challenge_method", "plain"), "invalid_request"],
      ["no state", (p: URLSearchParams) => p.delete("state"), "invalid_request"],
      ["the implicit flow", (p: URLSearchParams) => p.set("response_type", "token"), "unsupported_response_type"],
      ["another server's resource", (p: URLSearchParams) => p.set("resource", "https://elsewhere.example/mcp"), "invalid_target"],
    ])("sends the error back to the client for %s", async (_case, change, error) => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge, state: "keep-me" });
      change(params);
      const res = await authorizeRequest(params);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe(params.get("state") ? "keep-me" : null);
      expect(location.searchParams.get("code")).toBeNull();
    });

    it("lets a loopback client come back on another port", async () => {
      signInAs(ownerId);
      const clientId = await registerClient({ redirect_uris: ["http://127.0.0.1:3334/callback"] });
      const params = authorizationParams({
        clientId,
        challenge: pkce().challenge,
        redirectUri: "http://127.0.0.1:61234/callback",
      });
      const res = await authorizeRequest(params);
      expect(res.headers.get("location")).toBe(`${BASE_URL}/oauth/consent?${params}`);
    });
  });

  describe("consent", () => {
    it("connects nothing when cancelled", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const res = await consentRequest(params, { decision: "cancel" });
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("state")).toBe("state-123");
      expect(location.searchParams.get("code")).toBeNull();
      expect(await db.prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
    });

    it("issues a code bound to the person and their workspace, with every scope ticked", async () => {
      const clientId = await registerClient();
      const { code } = await approve({ userId: ownerId, clientId });
      const stored = await db.prisma.oAuthAuthorizationCode.findUniqueOrThrow({
        where: { codeHash: createHash("sha256").update(code).digest("hex") },
      });
      expect(stored).toMatchObject({
        clientId,
        userId: ownerId,
        workspaceId,
        scopes: ALL_SCOPES,
        redirectUri: CLAUDE_REDIRECT,
        usedAt: null,
      });
    });

    it("returns the code and state to the client with the issuer", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const location = new URL((await consentRequest(params)).headers.get("location")!);
      expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);
      expect(location.searchParams.get("state")).toBe("state-123");
      expect(location.searchParams.get("iss")).toBe(BASE_URL);
    });

    it("grants only what was left ticked, and always read", async () => {
      const readOnly = await connect({ userId: ownerId, grants: [] });
      expect(readOnly.scope).toBe("read");
      const noSend = await connect({ userId: ownerId, grants: ["read", "campaigns:write"] });
      expect(noSend.scope).toBe("read campaigns:write");
      const all = await connect({ userId: ownerId });
      expect(all.scope).toBe("read campaigns:write messages:send");
    });

    it("offers only what the client asked for", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const params = authorizationParams({ clientId, challenge, scope: "read" });
      const code = codeFrom(await consentRequest(params, { grants: ALL_SCOPES }));
      const res = await exchange(clientId, code, verifier);
      expect((await res.json()).scope).toBe("read");
    });

    it("lets only someone who can manage the workspace consent", async () => {
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const res = await consentRequest(params);
      expect(res.status).toBe(403);
      expect(await db.prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);

      const admin = await addMember(db.prisma, workspaceId, "ADMIN");
      signInAs(admin.id);
      expect((await consentRequest(params)).status).toBe(303);
    });

    it("sends someone who is signed out to sign in instead of approving", async () => {
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const res = await consentRequest(params);
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      expect(await db.prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
    });

    it("refuses an approval sent from another site or a frame", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const attempts: Record<string, string>[] = [
        { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Dest": "iframe" },
      ];
      for (const headers of attempts) {
        expect((await consentRequest(params, { headers })).status).toBe(403);
      }
      expect(await db.prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
    });

    it("re-checks the request, so an edited redirect URI goes nowhere", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      params.set("redirect_uri", "https://evil.example/cb");
      const res = await consentRequest(params);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("code exchange", () => {
    it("exchanges a code and its PKCE verifier for tokens", async () => {
      const clientId = await registerClient();
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      const res = await exchange(clientId, code, verifier);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toMatchObject({
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read campaigns:write messages:send",
      });
      expect(body.access_token).toMatch(/^ora_/);
      expect(body.refresh_token).toMatch(/^orr_/);
      expect((await mcpInitialize(`Bearer ${body.access_token}`)).status).toBe(200);
    });

    it("stores codes and tokens only as hashes", async () => {
      const tokens = await connect({ userId: ownerId });
      const dump = JSON.stringify(
        await Promise.all([
          db.prisma.oAuthToken.findMany(),
          db.prisma.oAuthAuthorizationCode.findMany(),
          db.prisma.oAuthConnection.findMany(),
        ])
      );
      expect(dump).not.toContain(tokens.access_token);
      expect(dump).not.toContain(tokens.refresh_token);
      expect(dump).toContain(createHash("sha256").update(tokens.access_token).digest("hex"));
    });

    it("refuses the wrong PKCE verifier", async () => {
      const clientId = await registerClient();
      const { code } = await approve({ userId: ownerId, clientId });
      const res = await exchange(clientId, code, pkce().verifier);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("refuses the wrong redirect URI", async () => {
      const clientId = await registerClient({ redirect_uris: [CLAUDE_REDIRECT, "https://claude.ai/other"] });
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      const res = await exchange(clientId, code, verifier, "https://claude.ai/other");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("refuses a code used twice and revokes what the first use gave out", async () => {
      const clientId = await registerClient();
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      const first = await (await exchange(clientId, code, verifier)).json();
      expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(200);

      const again = await exchange(clientId, code, verifier);
      expect(again.status).toBe(400);
      expect((await again.json()).error).toBe("invalid_grant");
      expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(401);
      expect((await refresh(clientId, first.refresh_token)).status).toBe(400);
    });

    it("refuses an expired code", async () => {
      const clientId = await registerClient();
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      await db.prisma.oAuthAuthorizationCode.updateMany({
        where: { clientId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await exchange(clientId, code, verifier);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("refuses another client's code and an unknown client", async () => {
      const clientId = await registerClient();
      const otherClient = await registerClient();
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      expect((await (await exchange(otherClient, code, verifier)).json()).error).toBe("invalid_grant");

      const unknown = await exchange("no-such-client", code, verifier);
      expect(unknown.status).toBe(401);
      expect((await unknown.json()).error).toBe("invalid_client");
    });

    it("refuses an unsupported grant type", async () => {
      const res = await tokenRequest({ grant_type: "client_credentials", client_id: "x" });
      expect((await res.json()).error).toBe("unsupported_grant_type");
    });
  });

  describe("refresh", () => {
    it("rotates the refresh token and issues a working access token", async () => {
      const tokens = await connect({ userId: ownerId });
      const res = await refresh(tokens.clientId, tokens.refresh_token);
      expect(res.status).toBe(200);
      const next = await res.json();
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect(next.access_token).not.toBe(tokens.access_token);
      expect(next.scope).toBe(tokens.scope);
      expect((await mcpInitialize(`Bearer ${next.access_token}`)).status).toBe(200);

      // The new refresh token keeps working, one rotation after another.
      const third = await refresh(tokens.clientId, next.refresh_token);
      expect(third.status).toBe(200);
    });

    it("revokes the connection when a rotated refresh token is used again", async () => {
      const tokens = await connect({ userId: ownerId });
      const next = await (await refresh(tokens.clientId, tokens.refresh_token)).json();

      const replay = await refresh(tokens.clientId, tokens.refresh_token);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");

      expect((await mcpInitialize(`Bearer ${next.access_token}`)).status).toBe(401);
      expect((await refresh(tokens.clientId, next.refresh_token)).status).toBe(400);
    });

    it("refuses an expired refresh token and another client's", async () => {
      const tokens = await connect({ userId: ownerId });
      const otherClient = await registerClient();
      expect((await refresh(otherClient, tokens.refresh_token)).status).toBe(400);

      await db.prisma.oAuthToken.updateMany({
        where: { kind: "REFRESH", connection: { clientId: tokens.clientId } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await (await refresh(tokens.clientId, tokens.refresh_token)).json()).error).toBe(
        "invalid_grant"
      );
    });
  });

  describe("Connected apps", () => {
    it("lists the workspace's connections with client, dates and scopes", async () => {
      const clientId = await registerClient({ client_name: "Claude for listing" });
      const tokens = await connect({ userId: ownerId, clientId, grants: ["read", "messages:send"] });
      await mcpInitialize(`Bearer ${tokens.access_token}`);

      signInAs(ownerId);
      const { status, body } = await connectionsList();
      expect(status).toBe(200);
      expect(body.data.canManage).toBe(true);
      const listed = body.data.connections.find(
        (c: { clientName: string }) => c.clientName === "Claude for listing"
      );
      expect(listed).toMatchObject({ scopes: ["read", "messages:send"] });
      expect(Date.parse(listed.createdAt)).not.toBeNaN();
      expect(Date.parse(listed.lastUsedAt)).not.toBeNaN();
    });

    it("replaces a client's earlier connection when it is approved again", async () => {
      const clientId = await registerClient({ client_name: "Reconnecting app" });
      const first = await connect({ userId: ownerId, clientId });
      const second = await connect({ userId: ownerId, clientId });
      expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(401);
      expect((await mcpInitialize(`Bearer ${second.access_token}`)).status).toBe(200);

      signInAs(ownerId);
      const { body } = await connectionsList();
      expect(
        body.data.connections.filter((c: { clientName: string }) => c.clientName === "Reconnecting app")
      ).toHaveLength(1);
    });

    it("revokes a connection, effective on its very next request", async () => {
      const clientId = await registerClient({ client_name: "To revoke" });
      const tokens = await connect({ userId: ownerId, clientId });
      expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(200);

      signInAs(ownerId);
      const { body } = await connectionsList();
      const { id } = body.data.connections.find((c: { clientName: string }) => c.clientName === "To revoke");
      const res = await revoke(id);
      expect(res.status).toBe(200);

      const refused = await mcpInitialize(`Bearer ${tokens.access_token}`);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect((await refresh(clientId, tokens.refresh_token)).status).toBe(400);
      expect(
        (await connectionsList()).body.data.connections.some((c: { id: string }) => c.id === id)
      ).toBe(false);

      // Going through consent again connects it again.
      const again = await connect({ userId: ownerId, clientId });
      expect((await mcpInitialize(`Bearer ${again.access_token}`)).status).toBe(200);
    });

    it("keeps connections to their own workspace", async () => {
      const clientId = await registerClient({ client_name: "Mine only" });
      await connect({ userId: ownerId, clientId });
      signInAs(ownerId);
      const { id } = (await connectionsList()).body.data.connections.find(
        (c: { clientName: string }) => c.clientName === "Mine only"
      );

      const stranger = await createOwner(db.prisma, "stranger");
      signInAs(stranger.user.id);
      expect((await connectionsList()).body.data.connections).toEqual([]);
      expect((await revoke(id)).status).toBe(404);
    });

    it("lets a member see connections but not revoke them", async () => {
      const clientId = await registerClient({ client_name: "Seen by member" });
      await connect({ userId: ownerId, clientId });
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      const { body } = await connectionsList();
      expect(body.data.canManage).toBe(false);
      const { id } = body.data.connections.find((c: { clientName: string }) => c.clientName === "Seen by member");
      expect((await revoke(id)).status).toBe(403);
    });

    it("needs a signed-in person", async () => {
      expect((await connectionsList()).status).toBe(401);
      expect((await revoke("anything")).status).toBe(401);
    });
  });

  describe("the MCP endpoint", () => {
    it.each([
      ["a malformed header", "Basic dXNlcjpwYXNz"],
      ["an empty bearer", "Bearer "],
      ["an unknown token", "Bearer ora_not-a-real-token"],
    ])("refuses %s", async (_case, header) => {
      const res = await mcpInitialize(header);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
    });

    it("refuses an expired access token", async () => {
      const tokens = await connect({ userId: ownerId });
      await db.prisma.oAuthToken.updateMany({
        where: { kind: "ACCESS", connection: { clientId: tokens.clientId } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await mcpInitialize(`Bearer ${tokens.access_token}`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });

    it("refuses a refresh token used as an access token", async () => {
      const tokens = await connect({ userId: ownerId });
      expect((await mcpInitialize(`Bearer ${tokens.refresh_token}`)).status).toBe(401);
    });

    it("stops a connection whose person can no longer manage the workspace", async () => {
      const admin = await addMember(db.prisma, workspaceId, "ADMIN");
      const tokens = await connect({ userId: admin.id });
      expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(200);
      await db.prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: admin.id } },
        data: { role: "MEMBER" },
      });
      expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
    });
  });
});
