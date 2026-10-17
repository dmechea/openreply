/**
 * The OAuth handshake that connects the Claude app to OpenReply, end to end
 * as plain requests against a real Postgres: discovery, registration,
 * authorize, consent, the PKCE code exchange, refresh rotation, revoking a
 * connection from Settings, and the MCP endpoint refusing what it should.
 * Needs TEST_DATABASE_URL; see docs/testing.md.
 */
import { createHash } from "node:crypto";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from "../lib/i18n";
import ptBR from "../lib/i18n/pt-BR.json";
import zhTW from "../lib/i18n/zh-TW.json";
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
// The consent page and the refusals a browser sees read the interface
// language from the request's cookies through next/headers. A test chooses
// the language with useLocale; without it they answer in English.
const cookieStore = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => new Headers(),
}));

import { GET as rootResourceMetadata } from "../app/.well-known/oauth-protected-resource/route";
import { GET as resourceMetadata } from "../app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as serverMetadata } from "../app/.well-known/oauth-authorization-server/route";
import {
  DELETE as revokeConnection,
  GET as listConnections,
} from "../app/api/oauth/connections/route";
import { POST as registerRoute } from "../app/api/oauth/register/route";
import { POST as tokenRoute } from "../app/api/oauth/token/route";
import ConsentPage from "../app/oauth/consent/page";

let db: TestDatabase;
let ownerId = "";
let workspaceId = "";

const RESOURCE_METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/api/mcp`;

function hashOf(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

/** Makes the next requests carry this interface language's cookie. */
function useLocale(locale: string) {
  cookieStore.get.mockImplementation((name: string) =>
    name === LOCALE_COOKIE ? { name, value: locale } : undefined
  );
}

/** The query as Next hands it to a page, where a repeated parameter becomes a list. */
function searchParamsOf(params: URLSearchParams) {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of params) {
    const seen = query[name];
    query[name] = seen === undefined ? value : [seen, value].flat();
  }
  return query;
}

/** The consent page for these parameters: where it redirects, or what it shows. */
async function consentPage(params: URLSearchParams) {
  let page: Awaited<ReturnType<typeof ConsentPage>>;
  try {
    page = await ConsentPage({ searchParams: Promise.resolve(searchParamsOf(params)) });
  } catch (error) {
    if (!isRedirectError(error)) throw error;
    return { location: getURLFromRedirectError(error), html: null };
  }
  return { location: null, html: renderToStaticMarkup(page) };
}

/**
 * A request body of `size` bytes, streamed a kilobyte at a time, that counts
 * how much of it the route pulled.
 */
function streamedBody(size: number) {
  const chunk = new TextEncoder().encode("a".repeat(1024));
  const pulled = { bytes: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.bytes >= size) return controller.close();
      pulled.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { body, pulled };
}

/** A POST whose body is streamed, with or without a declared Content-Length. */
function streamedPost(
  path: string,
  contentType: string,
  body: ReadableStream<Uint8Array>,
  contentLength?: number
) {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
    },
    body,
    duplex: "half",
  } as RequestInit);
}

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
    cookieStore.get.mockReset();
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

    it("refuses an oversized registration without reading all of it", async () => {
      const declared = streamedBody(5_000_000);
      const res = await registerRoute(
        streamedPost("/api/oauth/register", "application/json", declared.body, 5_000_000)
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_client_metadata");
      expect(declared.pulled.bytes).toBeLessThan(10_000);

      const undeclared = streamedBody(5_000_000);
      const chunked = await registerRoute(
        streamedPost("/api/oauth/register", "application/json", undeclared.body)
      );
      expect(chunked.status).toBe(400);
      expect((await chunked.json()).error).toBe("invalid_client_metadata");
      expect(undeclared.pulled.bytes).toBeLessThan(100_000);
    });

    it("drops a client nobody approved within 30 days when another one registers", async () => {
      const neverApproved = await registerClient({ client_name: "Never approved" });
      const connected = (await connect({ userId: ownerId })).clientId;
      const awaitingExchange = await registerClient({ client_name: "Awaiting exchange" });
      await approve({ userId: ownerId, clientId: awaitingExchange });
      const recent = await registerClient({ client_name: "Recent" });
      await db.prisma.oAuthClient.updateMany({
        where: { id: { in: [neverApproved, connected, awaitingExchange] } },
        data: { createdAt: new Date(Date.now() - 31 * 86_400_000) },
      });

      await registerClient();
      const left = await db.prisma.oAuthClient.findMany({
        where: { id: { in: [neverApproved, connected, awaitingExchange, recent] } },
        select: { id: true },
      });
      expect(left.map((client) => client.id).sort()).toEqual(
        [connected, awaitingExchange, recent].sort()
      );
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

    it("hands the consent page the request it checked and nothing else", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const sent = new URLSearchParams(params);
      sent.append("client_id", "not-a-client");
      sent.set("prompt", "consent");

      const res = await authorizeRequest(sent);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${BASE_URL}/oauth/consent?${params}`);

      signOut();
      const signIn = new URL((await authorizeRequest(sent)).headers.get("location")!);
      expect(signIn.searchParams.get("callbackUrl")).toBe(`/api/oauth/authorize?${params}`);
    });

    it("never redirects for an unknown client or an unregistered redirect URI", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const { challenge } = pkce();
      for (const [params, message] of [
        [
          authorizationParams({ clientId: "not-a-client", challenge }),
          "This app is not registered with OpenReply.",
        ],
        [
          authorizationParams({ clientId, challenge, redirectUri: "https://evil.example/cb" }),
          "The redirect URI does not match the one this app registered.",
        ],
      ] as const) {
        const res = await authorizeRequest(params);
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
        expect(await res.text()).toBe(message);
      }
    });

    it("explains a request it cannot redirect in the person's interface language", async () => {
      const params = authorizationParams({ clientId: "not-a-client", challenge: pkce().challenge });
      useLocale("zh-TW");
      const res = await authorizeRequest(params);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(zhTW["This app is not registered with OpenReply."]);
    });

    it.each([
      ["no PKCE challenge", (p: URLSearchParams) => p.delete("code_challenge"), "invalid_request"],
      ["the plain PKCE method", (p: URLSearchParams) => p.set("code_challenge_method", "plain"), "invalid_request"],
      ["no state", (p: URLSearchParams) => p.delete("state"), "invalid_request"],
      ["the implicit flow", (p: URLSearchParams) => p.set("response_type", "token"), "unsupported_response_type"],
      ["another server's resource", (p: URLSearchParams) => p.set("resource", "https://elsewhere.example/mcp"), "invalid_target"],
      ["a scope OpenReply does not have", (p: URLSearchParams) => p.set("scope", "foo"), "invalid_scope"],
      ["only scopes OpenReply does not have", (p: URLSearchParams) => p.set("scope", "foo bar"), "invalid_scope"],
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
      expect(location.searchParams.get("iss")).toBe(BASE_URL);
      expect(location.searchParams.get("code")).toBeNull();
    });

    it("sends someone who is signed out to sign in before any error goes back to the client", async () => {
      const clientId = await registerClient({ redirect_uris: ["https://evil.example/phish"] });
      const params = authorizationParams({
        clientId,
        challenge: pkce().challenge,
        redirectUri: "https://evil.example/phish",
      });
      params.set("response_type", "token");
      const res = await authorizeRequest(params);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(`${BASE_URL}/login`);
      expect(location.searchParams.get("callbackUrl")).toBe(`/api/oauth/authorize?${params}`);

      // Once signed in, the same request is refused at the client's redirect URI.
      signInAs(ownerId);
      const signedIn = new URL((await authorizeRequest(params)).headers.get("location")!);
      expect(signedIn.origin + signedIn.pathname).toBe("https://evil.example/phish");
      expect(signedIn.searchParams.get("error")).toBe("unsupported_response_type");
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

    it.each([
      ["no scope", null, "read campaigns:write messages:send"],
      ["an empty scope", "", "read campaigns:write messages:send"],
      ["a known and an unknown scope", "messages:send foo", "read messages:send"],
    ])("offers what the client asked for, always with read, given %s", async (_case, scope, granted) => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const params = authorizationParams({ clientId, challenge });
      if (scope === null) params.delete("scope");
      else params.set("scope", scope);
      const code = codeFrom(await consentRequest(params, { grants: ALL_SCOPES }));
      const res = await exchange(clientId, code, verifier);
      expect((await res.json()).scope).toBe(granted);
    });

    it("re-checks the scopes, so a request for none OpenReply has goes back refused", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge, scope: "foo bar" });
      const res = await consentRequest(params);
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_scope");
      expect(location.searchParams.get("state")).toBe("state-123");
      expect(location.searchParams.get("iss")).toBe(BASE_URL);
      expect(location.searchParams.get("code")).toBeNull();
      expect(await db.prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
    });

    it("lets only someone who can manage the workspace consent", async () => {
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const res = await consentRequest(params);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Only workspace owners and admins can connect apps.");
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

    it("answers a refusal in the person's interface language, English by default", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      const crossSite = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
      const message = "This approval must come from the OpenReply consent page.";

      const english = await consentRequest(params, { headers: crossSite });
      expect(english.status).toBe(403);
      expect(await english.text()).toBe(message);

      useLocale("zh-TW");
      const chinese = await consentRequest(params, { headers: crossSite });
      expect(chinese.status).toBe(403);
      expect(await chinese.text()).toBe(zhTW[message]);

      const edited = new URLSearchParams(params);
      edited.set("redirect_uri", "https://evil.example/cb");
      const mismatch = await consentRequest(edited);
      expect(mismatch.status).toBe(400);
      expect(await mismatch.text()).toBe(
        zhTW["The redirect URI does not match the one this app registered."]
      );

      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      useLocale("pt-BR");
      const notAllowed = await consentRequest(params);
      expect(notAllowed.status).toBe(403);
      expect(await notAllowed.text()).toBe(ptBR["Only workspace owners and admins can connect apps."]);
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

  describe("the consent page", () => {
    it("sends someone who is signed out to sign in before any error goes back to the client", async () => {
      const clientId = await registerClient({ redirect_uris: ["https://evil.example/phish"] });
      const params = authorizationParams({
        clientId,
        challenge: pkce().challenge,
        redirectUri: "https://evil.example/phish",
      });
      params.set("response_type", "token");
      const { location } = await consentPage(params);
      expect(location).not.toBeNull();
      const url = new URL(location!);
      expect(url.origin + url.pathname).toBe(`${BASE_URL}/login`);
      expect(url.searchParams.get("callbackUrl")).toBe(`/api/oauth/authorize?${params}`);

      signInAs(ownerId);
      const signedIn = new URL((await consentPage(params)).location!);
      expect(signedIn.origin + signedIn.pathname).toBe("https://evil.example/phish");
      expect(signedIn.searchParams.get("error")).toBe("unsupported_response_type");
    });

    it("reads a repeated parameter by its first value, as authorize does", async () => {
      signInAs(ownerId);
      const clientId = await registerClient();
      const params = authorizationParams({ clientId, challenge: pkce().challenge });
      params.append("client_id", "not-a-client");
      const { location, html } = await consentPage(params);
      expect(location).toBeNull();
      expect(html).toContain("Connect Claude to OpenReply?");
      expect(html).toContain(`name="client_id" value="${clientId}"`);
      expect(html).not.toContain("not-a-client");
    });

    it("lets a member who cannot connect apps only cancel", async () => {
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      const clientId = await registerClient();
      const { html } = await consentPage(authorizationParams({ clientId, challenge: pkce().challenge }));
      expect(html).toContain("Only workspace owners and admins can connect apps.");
      expect(html).toContain(`name="client_id" value="${clientId}"`);
      expect(html).toContain('value="cancel"');
      expect(html).not.toContain('value="allow"');
      expect(html).not.toContain('name="grant"');
    });

    it("explains an unknown client in place, signed in or not", async () => {
      const params = authorizationParams({ clientId: "not-a-client", challenge: pkce().challenge });
      for (const signedIn of [false, true]) {
        if (signedIn) signInAs(ownerId);
        const { location, html } = await consentPage(params);
        expect(location).toBeNull();
        expect(html).toContain("This app is not registered with OpenReply.");
      }
    });

    it("names where the person will be sent back to, scheme and all for an app's own scheme", async () => {
      signInAs(ownerId);
      const claude = await registerClient();
      const claudePage = await consentPage(authorizationParams({ clientId: claude, challenge: pkce().challenge }));
      expect(claudePage.html).toContain("sent back to claude.ai.");

      // An app's own scheme can look like a website's name, with or without a
      // host after it, so it is never shown as one.
      const lookalikes = [
        ["evilapp://claude.ai/callback", "evilapp://claude.ai/callback"],
        ["claude.ai:/callback", "claude.ai:/callback"],
        ["claude.ai:callback?from=claude.ai", "claude.ai:callback"],
      ];
      for (const [redirectUri, shown] of lookalikes) {
        const lookalike = await registerClient({ redirect_uris: [redirectUri] });
        const { html } = await consentPage(
          authorizationParams({ clientId: lookalike, challenge: pkce().challenge, redirectUri })
        );
        expect(html).toContain("Connect Claude to OpenReply?");
        expect(html).toContain(`sent back to ${shown}.`);
        expect(html).not.toContain("sent back to claude.ai.");
      }
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

    it("revokes nothing for a used code presented without its verifier or redirect URI", async () => {
      const clientId = await registerClient({ redirect_uris: [CLAUDE_REDIRECT, "https://claude.ai/other"] });
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      const first = await (await exchange(clientId, code, verifier)).json();

      const wrongVerifier = await exchange(clientId, code, pkce().verifier);
      expect((await wrongVerifier.json()).error).toBe("invalid_grant");
      const wrongRedirect = await exchange(clientId, code, verifier, "https://claude.ai/other");
      expect((await wrongRedirect.json()).error).toBe("invalid_grant");

      // Long after the code expired, too.
      await db.prisma.oAuthAuthorizationCode.update({
        where: { codeHash: hashOf(code) },
        data: { expiresAt: new Date(Date.now() - 20 * 3_600_000) },
      });
      const late = await tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: "x".repeat(43),
      });
      expect((await late.json()).error).toBe("invalid_grant");

      expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(200);
      expect((await refresh(clientId, first.refresh_token)).status).toBe(200);
    });

    it("revokes the connection when the same code is exchanged twice at once", async () => {
      for (let round = 0; round < 10; round++) {
        const clientId = await registerClient();
        const { code, verifier } = await approve({ userId: ownerId, clientId });
        const results = await Promise.all([
          exchange(clientId, code, verifier),
          exchange(clientId, code, verifier),
        ]);
        expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
        const winner = await results.find((res) => res.status === 200)!.json();
        expect((await mcpInitialize(`Bearer ${winner.access_token}`)).status).toBe(401);
        const connections = await db.prisma.oAuthConnection.findMany({ where: { clientId } });
        expect(connections).toHaveLength(1);
        expect(connections[0].revokedAt).not.toBeNull();
      }
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

    it("reads only form-encoded token requests", async () => {
      const clientId = await registerClient();
      const { code, verifier } = await approve({ userId: ownerId, clientId });
      const res = await tokenRoute(
        new Request(`${BASE_URL}/api/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            redirect_uri: CLAUDE_REDIRECT,
            code_verifier: verifier,
          }),
        })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");

      // The code is still good for a proper request.
      expect((await exchange(clientId, code, verifier)).status).toBe(200);
    });

    it("refuses an oversized token request without reading all of it", async () => {
      const form = "application/x-www-form-urlencoded";
      const declared = streamedBody(5_000_000);
      const res = await tokenRoute(streamedPost("/api/oauth/token", form, declared.body, 5_000_000));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
      expect(declared.pulled.bytes).toBeLessThan(10_000);

      const undeclared = streamedBody(5_000_000);
      const chunked = await tokenRoute(streamedPost("/api/oauth/token", form, undeclared.body));
      expect(chunked.status).toBe(400);
      expect((await chunked.json()).error).toBe("invalid_request");
      expect(undeclared.pulled.bytes).toBeLessThan(100_000);
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

    it("leaves the refresh token usable when issuing its successor fails", async () => {
      const tokens = await connect({ userId: ownerId });
      const failOnce = vi
        .spyOn(db.prisma, "$transaction")
        .mockRejectedValueOnce(new Error("Transaction API error: unable to start a transaction"));
      try {
        await expect(refresh(tokens.clientId, tokens.refresh_token)).rejects.toThrow();
      } finally {
        failOnce.mockRestore();
      }

      const retry = await refresh(tokens.clientId, tokens.refresh_token);
      expect(retry.status).toBe(200);
      const next = await retry.json();
      expect((await mcpInitialize(`Bearer ${next.access_token}`)).status).toBe(200);
      const connection = await db.prisma.oAuthToken.findUniqueOrThrow({
        where: { tokenHash: hashOf(next.access_token) },
        select: { connection: { select: { revokedAt: true } } },
      });
      expect(connection.connection.revokedAt).toBeNull();
    });

    it("refuses a refresh, and revokes the connection, once its person can no longer manage the workspace", async () => {
      const admin = await addMember(db.prisma, workspaceId, "ADMIN");
      const tokens = await connect({ userId: admin.id });
      const membership = { workspaceId_userId: { workspaceId, userId: admin.id } };
      await db.prisma.workspaceMember.update({ where: membership, data: { role: "MEMBER" } });

      const res = await refresh(tokens.clientId, tokens.refresh_token);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
      const connections = await db.prisma.oAuthConnection.findMany({
        where: { clientId: tokens.clientId },
      });
      expect(connections).toHaveLength(1);
      expect(connections[0].revokedAt).not.toBeNull();

      // Made an admin again, they have to connect again.
      await db.prisma.workspaceMember.update({ where: membership, data: { role: "ADMIN" } });
      expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
      expect((await refresh(tokens.clientId, tokens.refresh_token)).status).toBe(400);
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

    it("discards the tokens of the connection it replaces", async () => {
      const clientId = await registerClient({ client_name: "Replaced tokens" });
      const first = await connect({ userId: ownerId, clientId });
      const { connectionId } = await db.prisma.oAuthToken.findUniqueOrThrow({
        where: { tokenHash: hashOf(first.access_token) },
      });
      await connect({ userId: ownerId, clientId });

      const replaced = await db.prisma.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(replaced.revokedAt).not.toBeNull();
      expect(await db.prisma.oAuthToken.count({ where: { connectionId } })).toBe(0);
    });

    it("replaces the earlier connection in the same step that creates the new one", async () => {
      const clientId = await registerClient({ client_name: "Replaced at once" });
      const first = await connect({ userId: ownerId, clientId });
      const { code, verifier } = await approve({ userId: ownerId, clientId, grants: ["read"] });

      // The database goes away just after the exchange's own transaction
      // commits, so anything left to do after it fails.
      const realTransaction = db.prisma.$transaction.bind(db.prisma);
      const dropAfterExchange = vi
        .spyOn(db.prisma, "$transaction")
        .mockImplementationOnce(realTransaction)
        .mockRejectedValueOnce(new Error("Server has closed the connection"));
      let res: Response;
      try {
        res = await exchange(clientId, code, verifier);
      } finally {
        dropAfterExchange.mockRestore();
      }

      expect(res.status).toBe(200);
      expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(401);
      expect((await refresh(clientId, first.refresh_token)).status).toBe(400);
      const { access_token } = await res.json();
      expect((await mcpInitialize(`Bearer ${access_token}`)).status).toBe(200);
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
