import { handleMcpRequest } from "@/lib/mcp/handler";

export const dynamic = "force-dynamic";

// The MCP endpoint the Claude app connects to. See lib/mcp/handler.ts.
export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;
