import { corsPreflight, oauthJson, protectedResourceMetadata } from "@/lib/oauth/http";

// URLs come from the runtime NEXTAUTH_URL, so never prerender this.
export const dynamic = "force-dynamic";

// The same metadata at the root well-known URL, for clients that look there.
export function GET() {
  return oauthJson(protectedResourceMetadata());
}

export function OPTIONS() {
  return corsPreflight();
}
