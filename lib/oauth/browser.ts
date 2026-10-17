import type { NextRequest } from "next/server";
import { createI18n, LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";

// For the two endpoints a person's browser reaches, authorize and consent.
// Unlike the rest of the OAuth endpoints, they answer in the person's
// interface language.

/** A refusal shown to the person in their browser, not to the app. */
export function plainText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** The translator for the person's interface language, from the request's own cookie. */
export function requestI18n(request: NextRequest) {
  return createI18n(resolveLocale(request.cookies.get(LOCALE_COOKIE)?.value));
}
