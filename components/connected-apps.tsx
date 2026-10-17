"use client";

import { useEffect, useState } from "react";
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

/** Settings → Connected apps: OAuth connections to the MCP endpoint. */
export function ConnectedApps() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectorUrl, setConnectorUrl] = useState("");

  async function load() {
    const res = await fetch("/api/oauth/connections", { cache: "no-store" });
    const payload = await res.json();
    if (payload.success) setData(payload.data);
  }

  useEffect(() => {
    // Reads the browser's own origin, which only exists after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnectorUrl(`${window.location.origin}/api/mcp`);
    void load();
  }, []);

  const scopeLabels: Record<Scope, string> = {
    read: t("Read"),
    "campaigns:write": t("Edit campaigns"),
    "messages:send": t("Send DMs"),
  };

  async function revoke(id: string) {
    if (!confirm(t("Revoke this connection? The app loses access immediately."))) return;
    setError(null);
    setBusy(id);
    const res = await fetch(`/api/oauth/connections?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const payload = await res.json();
    if (!payload.success) setError(payload.error ?? t("Could not revoke the connection"));
    await load();
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
          <code className="min-w-0 flex-1 truncate text-sm text-foreground">{connectorUrl}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(connectorUrl)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
          >
            {t("Copy")}
          </button>
        </div>
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
              <p className="truncate text-sm font-semibold text-foreground">{connection.clientName}</p>
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
                onClick={() => revoke(connection.id)}
                disabled={busy === connection.id}
                className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
              >
                {busy === connection.id ? t("Revoking...") : t("Revoke")}
              </button>
            )}
          </div>
        ))}
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    </section>
  );
}
