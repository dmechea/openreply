import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { checkAuthorizationRequest } from "@/lib/oauth/authorization";
import { issuer, OAUTH_PATHS } from "@/lib/oauth/config";

export const dynamic = "force-dynamic";

// The authorization endpoint. It checks the request, sends a signed-out
// person through the usual magic-link sign-in and back here, and hands a
// signed-in one to the consent page, which issues the code.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const check = await checkAuthorizationRequest(params);
  if (!check.ok) {
    if (check.redirectTo) return NextResponse.redirect(check.redirectTo, 302);
    return new Response(check.description, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!(await getCurrentUserId())) {
    const login = new URL("/login", issuer());
    login.searchParams.set("callbackUrl", `${OAUTH_PATHS.authorize}?${params}`);
    return NextResponse.redirect(login, 302);
  }

  return NextResponse.redirect(`${issuer()}${OAUTH_PATHS.consent}?${params}`, 302);
}
