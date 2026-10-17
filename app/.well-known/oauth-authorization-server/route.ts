import { authorizationServerMetadata, corsPreflight, oauthJson } from "@/lib/oauth/http";

// URLs come from the runtime NEXTAUTH_URL, so never prerender this.
export const dynamic = "force-dynamic";

export function GET() {
  return oauthJson(authorizationServerMetadata());
}

export function OPTIONS() {
  return corsPreflight();
}
