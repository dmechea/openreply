import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getI18n } from "@/lib/i18n/server";
import {
  AUTHORIZATION_PARAMS,
  checkAuthorizationRequest,
} from "@/lib/oauth/authorization";
import { OAUTH_PATHS, type Scope } from "@/lib/oauth/config";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t("Connect an app - OpenReply") };
}

// Where the person is sent back to, in words they can check: a web address's
// host, or an app's own scheme.
function destinationOf(redirectUri: string) {
  const url = new URL(redirectUri);
  return url.host || url.protocol.replace(/:$/, "");
}

// The consent page for an authorization request. Approving posts the form to
// /api/oauth/consent, which checks everything again and issues the code.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await getI18n();
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const name of AUTHORIZATION_PARAMS) {
    const value = query[name];
    if (typeof value === "string") params.set(name, value);
  }

  const check = await checkAuthorizationRequest(params);
  if (!check.ok && check.redirectTo) redirect(check.redirectTo);

  const context = check.ok ? await getCurrentWorkspaceContext() : null;
  if (check.ok && !context) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`${OAUTH_PATHS.authorize}?${params}`)}`);
  }

  const user = context
    ? await prisma.user.findUnique({
        where: { id: context.userId },
        select: { email: true, name: true },
      })
    : null;
  const client = check.ok ? check.request.client.name : "";
  const scopeText: Record<Scope, string> = {
    read: t("{client} will be able to see your campaigns and their results, your posts and reels, and your DM conversations.", { client }),
    "campaigns:write": t("{client} will be able to create and edit campaigns, and switch them on or off.", { client }),
    "messages:send": t("{client} will be able to send DMs from your account. It will ask you before each one.", { client }),
  };

  const hiddenFields = AUTHORIZATION_PARAMS.filter((name) => params.has(name)).map((name) => (
    <input key={name} type="hidden" name={name} value={params.get(name) ?? ""} />
  ));

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {!check.ok || !context ? (
            <>
              <p role="alert" className="text-sm text-foreground">
                {t("This connection request is not valid. Start again from the app you were connecting.")}
              </p>
              {!check.ok && <p className="mt-3 text-xs text-muted">{check.description}</p>}
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-foreground">
                {t("Connect {client} to OpenReply?", { client })}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {t("Signed in as {email}, workspace {workspace}.", {
                  email: user?.email ?? user?.name ?? "",
                  workspace: context.workspace.name,
                })}
              </p>

              {canManageWorkspace(context.role) ? (
                <form method="post" action="/api/oauth/consent" className="mt-6 space-y-5">
                  {hiddenFields}
                  <fieldset className="space-y-3">
                    {check.request.scopes.map((scope) => (
                      <label
                        key={scope}
                        className="flex items-start gap-3 rounded border border-border bg-surface/70 p-3 text-sm text-foreground"
                      >
                        <input
                          type="checkbox"
                          name="grant"
                          value={scope}
                          defaultChecked
                          disabled={scope === "read"}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                        />
                        <span>
                          {scopeText[scope]}
                          {scope === "read" && (
                            <span className="mt-1 block text-xs text-muted">{t("Always included")}</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="text-xs text-muted">
                    {t("Untick anything you don't want to allow. You can revoke this connection at any time in Settings.")}{" "}
                    {t("After you allow it, you'll be sent back to {destination}.", {
                      destination: destinationOf(check.request.redirectUri),
                    })}
                  </p>
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      name="decision"
                      value="allow"
                      className="flex-1 rounded bg-accent px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
                    >
                      {t("Allow")}
                    </button>
                    <button
                      type="submit"
                      name="decision"
                      value="cancel"
                      className="flex-1 rounded border border-border px-6 py-3 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                    >
                      {t("Cancel")}
                    </button>
                  </div>
                </form>
              ) : (
                <form method="post" action="/api/oauth/consent" className="mt-6 space-y-5">
                  {hiddenFields}
                  <p role="alert" className="text-sm text-foreground">
                    {t("Only workspace owners and admins can connect apps.")}
                  </p>
                  <button
                    type="submit"
                    name="decision"
                    value="cancel"
                    className="w-full rounded border border-border px-6 py-3 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                  >
                    {t("Cancel")}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
