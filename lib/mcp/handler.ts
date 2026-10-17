import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { issuer } from "@/lib/oauth/config";
import { authenticateAccessToken } from "@/lib/oauth/connections";
import { bearerChallenge } from "@/lib/oauth/http";
import { createMcpServer } from "@/lib/mcp/server";

/**
 * /api/mcp: the token check around a stateless MCP server. Each request
 * carries its own access token, is checked against the database, and gets a
 * server built for that connection alone, so nothing is shared between
 * requests and a revoked connection is refused on its next one.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const access = await authenticateAccessToken(request.headers.get("authorization"));
  if (!access.ok) {
    return Response.json(
      {
        error: access.reason === "missing" ? "unauthorized" : "invalid_token",
        error_description:
          access.reason === "missing"
            ? "Connect this app to OpenReply to use it"
            : "The access token is missing, expired or revoked",
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": bearerChallenge(access.reason === "invalid") },
      }
    );
  }

  // Stateless: no session to resume over GET and none to end over DELETE.
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  // A browser page on another site must not be able to drive the endpoint
  // (the MCP transport's DNS-rebinding rule). Native clients send no Origin.
  const origin = request.headers.get("origin");
  if (origin && origin !== issuer()) {
    return new Response("Invalid origin", { status: 403 });
  }

  const server = await createMcpServer(access.caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
