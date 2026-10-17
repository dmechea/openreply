import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  MAX_BATCH_SIZE,
  requestBodyTooLargeMessage,
} from "@modelcontextprotocol/sdk/server/requestBody.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CancelledNotificationSchema,
  ErrorCode,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { readBodyText } from "@/lib/oauth/body";
import { issuer } from "@/lib/oauth/config";
import { authenticateAccessToken, type McpCaller } from "@/lib/oauth/connections";
import { mcpUnauthorized } from "@/lib/oauth/http";
import { createMcpServer } from "@/lib/mcp/server";

// An MCP client stops waiting for an answer after a minute by default, so a
// request the server has not answered by then is answered as timed out.
const TIME_LIMIT_MS = DEFAULT_REQUEST_TIMEOUT_MSEC;

/**
 * /api/mcp: the token check around a stateless MCP server. Each request
 * carries its own access token, is checked against the database, and gets a
 * server built for that connection alone, so nothing is shared between
 * requests and a revoked connection is refused on its next one.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  // Stateless: no session to resume over GET and none to end over DELETE.
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  const access = await authenticateAccessToken(request.headers.get("authorization"));
  if (!access.ok) return mcpUnauthorized(access.reason);

  // A browser page on another site must not be able to drive the endpoint
  // (the MCP transport's DNS-rebinding rule). Native clients send no Origin.
  const origin = request.headers.get("origin");
  if (origin && origin !== issuer()) {
    return new Response("Invalid origin", { status: 403 });
  }

  // Read here rather than by the transport, so the server can be built for
  // what the POST holds. A body too large, not JSON, or cut off because the
  // client went away mid-upload is refused just as the transport would refuse it.
  let body: unknown;
  try {
    const text = await readBodyText(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (text === null) {
      return jsonRpcRefusal(413, requestBodyTooLargeMessage(DEFAULT_MAX_REQUEST_BODY_SIZE));
    }
    body = JSON.parse(text);
  } catch {
    return jsonRpcRefusal(400, "Parse error: Invalid JSON", ErrorCode.ParseError);
  }

  // The use is noted alongside the request's own work, and a failure to
  // note it fails nothing else.
  const recording = access
    .recordUse()
    .catch((error) => console.error("[MCP] Could not note the connection's use", error));
  try {
    return await serve(request, access.caller, withoutCancelledRequests(body));
  } finally {
    await recording;
  }
}

/** Runs the POST's messages through a server built for this caller alone. */
async function serve(request: Request, caller: McpCaller, body: unknown): Promise<Response> {
  const messages = Array.isArray(body) ? body : [body];
  const server = await createMcpServer(caller, { initializing: messages.some(isInitializeRequest) });
  const transport = new AnswerKeepingTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // The transport answers once every request in the POST has its response.
  // Should one never get it, the POST is answered anyway, and the server
  // closed, when the time limit passes or the client goes away.
  const deadline = deadlineFor(request.signal);
  try {
    return await Promise.race([
      transport.handleRequest(request, { parsedBody: body }),
      deadline.passed.then(() => timedOut(messages, transport.answers)),
    ]);
  } finally {
    deadline.clear();
    await server.close();
  }
}

/**
 * The POST's messages less any request that a notifications/cancelled in the
 * same POST names. A stateless server sees a cancellation only in its
 * request's own POST, and the SDK still runs a cancelled request but sends
 * nothing back for it, while the transport holds the POST open until every
 * request in it is answered. Dropped here, it neither runs nor holds up the POST.
 */
function withoutCancelledRequests(body: unknown): unknown {
  // A batch over the limit is left whole for the transport to refuse.
  if (!Array.isArray(body) || body.length > MAX_BATCH_SIZE) return body;
  const cancelled = new Set(
    body.flatMap((message) => {
      const cancel = isJSONRPCNotification(message) && CancelledNotificationSchema.safeParse(message);
      return cancel && cancel.success && cancel.data.params.requestId !== undefined
        ? [cancel.data.params.requestId]
        : [];
    })
  );
  return body.filter((message) => !(isJSONRPCRequest(message) && cancelled.has(message.id)));
}

/** Settles when the time limit passes or the client goes away, unless cleared first. */
function deadlineFor(signal: AbortSignal) {
  let clear = () => {};
  const passed = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TIME_LIMIT_MS);
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve();
    clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });
  return { passed, clear };
}

/**
 * The transport, also keeping each answer the server gives it. The transport
 * holds every answer back until the whole POST is answered, so without these
 * a request that did finish, such as a reply already sent, could only be
 * called unfinished once the time limit passes.
 */
class AnswerKeepingTransport extends WebStandardStreamableHTTPServerTransport {
  readonly answers = new Map<RequestId, JSONRPCMessage>();

  override send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }) {
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
      this.answers.set(message.id, message);
    }
    return super.send(message, options);
  }
}

/**
 * The POST's answer once its time is up: each request that finished gets its
 * own answer, and each that did not gets a timeout. A client that has gone
 * away reads no answer, so it gets the same one.
 */
function timedOut(messages: unknown[], answers: ReadonlyMap<RequestId, JSONRPCMessage>): Response {
  const replies = messages.filter(isJSONRPCRequest).map(
    (message) =>
      answers.get(message.id) ?? {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: ErrorCode.RequestTimeout, message: "OpenReply did not finish this request in time" },
      }
  );
  return Response.json(replies.length === 1 ? replies[0] : replies);
}

// -32000 is the server error the transport gives its own refusals.
function jsonRpcRefusal(status: number, message: string, code = -32000): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}
