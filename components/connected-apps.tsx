"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import type { Scope } from "@/lib/oauth/config";

interface Connection {
  id: string;
  clientName: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  connectedBy: string | null;
}

interface ConnectionsData {
  connections: Connection[];
  canManage: boolean;
}

/**
 * The JSON answer from `path`, or null when the request fails or the answer
 * is not JSON, such as an empty 500 or a proxy's error page.
 */
function getJson(path: string) {
  return fetch(path, { cache: "no-store" })
    .then((res) => res.json())
    .catch(() => null);
}

interface Loaded {
  data: ConnectionsData | null;
  connectorUrl: string | null;
}

/** The workspace's connections and the connector URL, each null when it did not load. */
async function fetchConnectedApps(): Promise<Loaded> {
  const [payload, metadata] = await Promise.all([
    getJson("/api/oauth/connections"),
    // The connector URL is the MCP endpoint's resource identifier, which the
    // server builds from NEXTAUTH_URL. Reading it from the endpoint's
    // metadata, not this page's address, keeps it right when the page is open
    // on another host that serves the same deployment.
    getJson("/.well-known/oauth-protected-resource/api/mcp"),
  ]);
  return {
    data: payload?.success ? payload.data : null,
    connectorUrl: typeof metadata?.resource === "string" ? metadata.resource : null,
  };
}

type CopyState = "idle" | "copied" | "failed";

/** Settings → Connected apps: OAuth connections to the MCP endpoint. */
export function ConnectedApps() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [connectorUrl, setConnectorUrl] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copiedTimer = useRef<number | undefined>(undefined);
  const urlRef = useRef<HTMLElement>(null);

  // A failed reload keeps the last list and URL on screen and says it failed.
  function show(loaded: Loaded) {
    if (loaded.data) setData(loaded.data);
    if (loaded.connectorUrl) setConnectorUrl(loaded.connectorUrl);
    setLoadFailed(!loaded.data || !loaded.connectorUrl);
  }

  useEffect(() => {
    void fetchConnectedApps().then(show);
  }, []);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const scopeLabels: Record<Scope, string> = {
    read: t("Read"),
    "campaigns:write": t("Edit campaigns"),
    "messages:send": t("Send DMs"),
  };

  async function copyConnectorUrl() {
    // Each copy shows its own outcome for the full time, however soon it
    // follows the last.
    window.clearTimeout(copiedTimer.current);
    try {
      // The clipboard is there only on a secure page: https, or localhost.
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(connectorUrl);
      setCopyState("copied");
      copiedTimer.current = window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      // Selected, the URL can still be copied by hand.
      if (urlRef.current) window.getSelection()?.selectAllChildren(urlRef.current);
      setCopyState("failed");
    }
  }

  async function revoke(id: string) {
    if (!confirm(t("Revoke this connection? The app loses access immediately."))) return;
    setError(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/oauth/connections?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const payload = await res.json();
      if (!payload.success) setError(payload.error ?? t("Could not revoke the connection"));
    } catch {
      // No readable answer: the request failed, or the server or a proxy sent
      // an error without JSON.
      setError(t("Could not revoke the connection"));
    }
    // Reload either way, since a lost answer may still have revoked it.
    show(await fetchConnectedApps());
    setBusy(null);
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold">{t("Connected apps")}</h2>
      <p className="mt-1 text-sm text-muted">
        {t("Apps such as Claude that can use this workspace. Revoking one stops its access straight away.")}
      </p>

      <div className="mt-4 rounded border border-border bg-surface/70 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t("Connector URL")}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code ref={urlRef} className="min-w-0 flex-1 truncate text-sm text-foreground">
            {connectorUrl}
          </code>
          <button
            type="button"
            onClick={() => void copyConnectorUrl()}
            disabled={!connectorUrl}
            className="inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-all hover:border-border-hover disabled:cursor-default disabled:opacity-50"
          >
            {copyState === "copied" ? t("Copied!") : t("Copy")}
          </button>
        </div>
        {copyState === "failed" && (
          <p className="mt-2 text-xs text-error">
            {t("Could not copy. The URL is selected, so copy it from there.")}
          </p>
        )}
        <p className="mt-2 text-xs text-muted">
          {t("Add this URL as a custom connector in the Claude app to connect it.")}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {data && data.connections.length === 0 && (
          <p className="text-sm text-muted">{t("No apps are connected.")}</p>
        )}
        {data?.connections.map((connection) => (
          <div
            key={connection.id}
            className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              {/* Set apart, as on the consent page, so a right-to-left name reads the same here. */}
              <p className="truncate text-sm font-semibold text-foreground">
                <bdi>{connection.clientName}</bdi>
              </p>
              <p className="mt-1 text-xs text-muted">
                {t("Connected {date} by {person}", {
                  date: new Date(connection.createdAt).toLocaleDateString(locale),
                  person: connection.connectedBy ?? t("Unknown member"),
                })}{" "}
                ·{" "}
                {connection.lastUsedAt
                  ? t("Last used {date}", {
                      date: new Date(connection.lastUsedAt).toLocaleString(locale),
                    })
                  : t("Never used")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {connection.scopes.map((scope) => (
                  <span
                    key={scope}
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted"
                  >
                    {scopeLabels[scope]}
                  </span>
                ))}
              </div>
            </div>
            {data.canManage && (
              <button
                type="button"
                onClick={() => void revoke(connection.id)}
                disabled={busy === connection.id}
                className="inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:cursor-default disabled:opacity-50"
              >
                {busy === connection.id ? t("Revoking...") : t("Revoke")}
              </button>
            )}
          </div>
        ))}
        {error && <p className="text-sm text-error">{error}</p>}
        {loadFailed && <p className="text-sm text-error">{t("Could not load connected apps")}</p>}
      </div>
    </section>
  );
}
