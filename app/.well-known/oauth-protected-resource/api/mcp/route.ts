import { corsPreflight, oauthJson, protectedResourceMetadata } from "@/lib/oauth/http";

// URLs come from the runtime NEXTAUTH_URL, so never prerender this.
export const dynamic = "force-dynamic";

// RFC 9728 metadata for /api/mcp, at its path-inserted well-known URL.
export function GET() {
  return oauthJson(protectedResourceMetadata());
}

export function OPTIONS() {
  return corsPreflight();
}
