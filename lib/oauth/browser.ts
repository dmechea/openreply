import type { StaticMessageKey } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

// For the two endpoints a person's browser reaches, authorize and consent.
// Unlike the rest of the OAuth endpoints, they answer in the person's
// interface language.

/** A refusal shown to the person in their browser, not to the app, in their language. */
export async function refusal(message: StaticMessageKey, status: number): Promise<Response> {
  const { t } = await getI18n();
  return new Response(t(message), {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
