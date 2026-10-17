import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import {
  AUTHORIZATION_PROBLEMS,
  checkAuthorizationRequest,
  signInUrl,
} from "@/lib/oauth/authorization";
import { issuer, OAUTH_PATHS } from "@/lib/oauth/config";
import { plainText, requestI18n } from "@/lib/oauth/browser";

export const dynamic = "force-dynamic";

// The authorization endpoint. It checks the request, sends a signed-out
// person through the usual magic-link sign-in and back here, and hands a
// signed-in one to the consent page, which issues the code.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const check = await checkAuthorizationRequest(params);
  if (!check.ok) {
    if (check.redirectTo !== null) return NextResponse.redirect(check.redirectTo, 302);
    const { t } = requestI18n(request);
    return plainText(t(AUTHORIZATION_PROBLEMS[check.problem]), 400);
  }

  if (!(await getCurrentUserId())) {
    return NextResponse.redirect(signInUrl(params), 302);
  }

  return NextResponse.redirect(`${issuer()}${OAUTH_PATHS.consent}?${params}`, 302);
}
