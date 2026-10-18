import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import {
  AUTHORIZATION_PROBLEMS,
  checkAuthorizationRequest,
  readAuthorizationParams,
  signInUrl,
} from "@/lib/oauth/authorization";
import { issuer, OAUTH_PATHS } from "@/lib/oauth/config";
import { refusal } from "@/lib/oauth/browser";

export const dynamic = "force-dynamic";

// The authorization endpoint. It checks the request, sends a signed-out
// person through the usual magic-link sign-in and back here, and hands a
// signed-in one to the consent page, which issues the code.
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const params = readAuthorizationParams((name) => query.get(name));
  const check = await checkAuthorizationRequest(params);
  if (!check.ok && check.redirectTo === null) {
    return refusal(AUTHORIZATION_PROBLEMS[check.problem], 400);
  }

  // Nothing goes back to the client, not even an error, until the person has
  // signed in, so a stranger is never sent anywhere but sign-in (RFC 9700
  // §4.11.2).
  if (!(await getCurrentUserId())) {
    return NextResponse.redirect(signInUrl(params), 302);
  }
  if (!check.ok) return NextResponse.redirect(check.redirectTo, 302);

  return NextResponse.redirect(`${issuer()}${OAUTH_PATHS.consent}?${params}`, 302);
}
