import {
  Check,
  KeyRound,
  LoaderCircle,
  Search,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { policiesWithoutTools, type PolicyDefinition } from "@quorum/core";

import {
  getWebSearchSettings,
  updateWebSearchSettings,
  type KeyedWebSearchProviderId,
  type WebSearchProviderId,
  type WebSearchSettings,
} from "../lib/api";

const KEYED_PROVIDERS = new Set<KeyedWebSearchProviderId>([
  "exa",
  "perplexity",
  "tavily",
  "brave",
  "firecrawl",
]);

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /**
   * The runtime's own policy definitions, so the note below can name the
   * tool-free policies instead of remembering them. Absent until the runtime
   * has loaded, in which case the sentence is omitted — no claim is safer than
   * a remembered one.
   */
  policies?: readonly PolicyDefinition[] | undefined;
}

/**
 * "Private and Offline policies never search."
 *
 * That was two policy names written by hand next to the field that decides it:
 * true when written, silently false the moment a `toolCeiling` moves or a
 * policy is added. It is the same shape as the `offline` card that stated the
 * opposite of its own ceiling, so it gets the same treatment — read the value.
 */
export function searchlessPolicyNote(
  policies: readonly PolicyDefinition[] | undefined,
): string {
  const names = policiesWithoutTools(policies ?? []);
  if (names.length === 0) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "does" : "do"} not search.`;
}

export function canSaveWebSearchSettings(
  settingsLoaded: boolean,
  enabled: boolean,
  selectedProviderReady: boolean,
  saving: boolean,
): boolean {
  return (
    settingsLoaded &&
    !saving &&
    (!enabled || selectedProviderReady)
  );
}

function providerLabel(
  settings: WebSearchSettings | undefined,
  provider: WebSearchProviderId,
): string {
  if (provider === "auto") return "Auto";
  return (
    settings?.providers.find((candidate) => candidate.id === provider)?.label ??
    provider
  );
}

export function SettingsDialog({
  open,
  onClose,
  onSaved,
  policies,
}: SettingsDialogProps) {
  const [settings, setSettings] = useState<WebSearchSettings>();
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState<WebSearchProviderId>("auto");
  const [resultLimit, setResultLimit] = useState(5);
  const [searxngBaseUrl, setSearxngBaseUrl] = useState("");
  const [apiKeyChanges, setApiKeyChanges] = useState<
    Partial<Record<KeyedWebSearchProviderId, string | null>>
  >({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setSettings(undefined);
      setApiKeyChanges({});
      setError(undefined);
      setWarning(undefined);
      setSaved(false);
      return;
    }
    let active = true;
    setSettings(undefined);
    setApiKeyChanges({});
    setLoading(true);
    setError(undefined);
    setWarning(undefined);
    setSaved(false);
    void getWebSearchSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setEnabled(next.enabled);
        setProvider(next.provider);
        setResultLimit(next.resultLimit);
        setSearxngBaseUrl(next.searxngBaseUrl ?? "");
        setApiKeyChanges({});
      })
      .catch((reason) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load web-search settings.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hasAttribute("hidden"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const activeElement = document.activeElement;
      if (!dialog.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, saving]);

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        ".app-shell > :not(.settings-backdrop)",
      ),
    ];
    const priorBackgroundState = new Map(
      background.map((element) => [
        element,
        {
          ariaHidden: element.getAttribute("aria-hidden"),
          inert: element.hasAttribute("inert"),
        },
      ]),
    );
    for (const element of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    const focusFrame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      for (const element of background) {
        const previous = priorBackgroundState.get(element);
        if (!previous?.inert) element.removeAttribute("inert");
        if (previous?.ariaHidden === null || previous === undefined) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", previous.ariaHidden);
        }
      }
      if (priorFocusRef.current?.isConnected) priorFocusRef.current.focus();
      priorFocusRef.current = null;
    };
  }, [open]);

  const selectedProvider = useMemo(
    () =>
      provider === "auto"
        ? undefined
        : settings?.providers.find((candidate) => candidate.id === provider),
    [provider, settings],
  );
  const selectedKeyChange = KEYED_PROVIDERS.has(
    provider as KeyedWebSearchProviderId,
  )
    ? apiKeyChanges[provider as KeyedWebSearchProviderId]
    : undefined;
  const selectedProviderReady =
    provider === "auto" ||
    provider === "duckduckgo" ||
    (provider === "searxng"
      ? Boolean(
          searxngBaseUrl.trim() || selectedProvider?.environmentConfigured,
        )
      : selectedKeyChange === null
        ? selectedProvider?.environmentConfigured === true
        : typeof selectedKeyChange === "string"
          ? Boolean(
              selectedKeyChange.trim() || selectedProvider?.configured,
            )
          : selectedProvider?.configured === true);
  const canSave = canSaveWebSearchSettings(
    settings !== undefined,
    enabled,
    selectedProviderReady,
    saving,
  );

  if (!open) return null;

  const save = async () => {
    if (!settings || !canSave) return;
    setSaving(true);
    setError(undefined);
    setWarning(undefined);
    setSaved(false);
    try {
      const changedKeys = Object.fromEntries(
        Object.entries(apiKeyChanges).filter(
          ([, value]) => value === null || Boolean(value?.trim()),
        ),
      ) as Partial<Record<KeyedWebSearchProviderId, string | null>>;
      const next = await updateWebSearchSettings({
        enabled,
        provider,
        resultLimit,
        ...(searxngBaseUrl.trim() !== (settings.searxngBaseUrl ?? "")
          ? { searxngBaseUrl: searxngBaseUrl.trim() || null }
          : {}),
        ...(Object.keys(changedKeys).length > 0
          ? { apiKeys: changedKeys }
          : {}),
      });
      setSettings(next);
      setEnabled(next.enabled);
      setProvider(next.provider);
      setResultLimit(next.resultLimit);
      setSearxngBaseUrl(next.searxngBaseUrl ?? "");
      setApiKeyChanges({});
      setSaved(true);
      try {
        await onSaved();
      } catch {
        setWarning(
          "Settings were saved and activated, but the runtime status could not be refreshed yet.",
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save web-search settings.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <header className="settings-heading">
          <div>
            <span className="eyebrow">Quorum settings</span>
            <h2 id="settings-title">Web search</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="icon-button"
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close settings"
          >
            <X size={17} />
          </button>
        </header>

        {loading ? (
          <div className="settings-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            Loading search providers…
          </div>
        ) : settings ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="settings-scroll">
              <label className="settings-toggle">
                <span>
                  <strong>Enable web search</strong>
                  <small>
                    Balanced and Best quality may search automatically when
                    current sources are required.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
              </label>

              <div className="settings-grid">
                <label>
                  <span>Provider</span>
                  <select
                    value={provider}
                    onChange={(event) =>
                      setProvider(event.target.value as WebSearchProviderId)
                    }
                  >
                    <option value="auto">Auto (recommended)</option>
                    {settings.providers.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}
                        {candidate.configured ? "" : " · setup required"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Results per search</span>
                  <select
                    value={resultLimit}
                    onChange={(event) =>
                      setResultLimit(Number(event.target.value))
                    }
                  >
                    {Array.from({ length: 8 }, (_, index) => index + 3).map(
                      (count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>

              <div className="auto-order">
                <Search size={14} />
                <p>
                  Auto tries the first configured provider in this order:{" "}
                  {settings.autoOrder
                    .map((candidate) => providerLabel(settings, candidate))
                    .join(" → ")}
                  . If one fails, Quorum records the fallback and tries the
                  next.
                </p>
              </div>

              <div className="provider-settings">
                <div className="settings-section-heading">
                  <strong>Provider configuration</strong>
                  <span>Entered keys remain in memory for this Quorum run.</span>
                </div>
                {settings.providers.map((candidate) => {
                  const keyed = KEYED_PROVIDERS.has(
                    candidate.id as KeyedWebSearchProviderId,
                  );
                  const keyedId = candidate.id as KeyedWebSearchProviderId;
                  const pendingKey = keyed ? apiKeyChanges[keyedId] : undefined;
                  return (
                    <div className="provider-setting" key={candidate.id}>
                      <div className="provider-setting-copy">
                        <div>
                          {candidate.requires === "api_key" ? (
                            <KeyRound size={14} />
                          ) : candidate.requires === "base_url" ? (
                            <Server size={14} />
                          ) : (
                            <ShieldCheck size={14} />
                          )}
                          <strong>{candidate.label}</strong>
                        </div>
                        <span>{candidate.description}</span>
                      </div>
                      <div
                        className={`provider-status ${
                          candidate.configured ? "is-ready" : ""
                        }`}
                      >
                        {candidate.configured ? "Ready" : "Needs setup"}
                      </div>

                      {candidate.id === "searxng" && (
                        <label className="provider-field">
                          <span>SearXNG base URL</span>
                          <input
                            type="url"
                            value={searxngBaseUrl}
                            placeholder="http://127.0.0.1:8080"
                            onChange={(event) =>
                              setSearxngBaseUrl(event.target.value)
                            }
                          />
                        </label>
                      )}

                      {keyed && (
                        <label className="provider-field">
                          <span>
                            {candidate.label} API key
                            {candidate.configurationSource
                              ? ` · ${candidate.configurationSource}`
                              : ""}
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            value={
                              typeof pendingKey === "string" ? pendingKey : ""
                            }
                            placeholder={
                              candidate.configured
                                ? "Configured — enter a session replacement"
                                : `Enter ${candidate.label} API key`
                            }
                            onChange={(event) =>
                              setApiKeyChanges((current) => ({
                                ...current,
                                [keyedId]: event.target.value,
                              }))
                            }
                          />
                        </label>
                      )}

                      {keyed &&
                        candidate.configurationSource === "session" &&
                        pendingKey !== null && (
                          <button
                            className="clear-credential"
                            type="button"
                            aria-label={`Remove session ${candidate.label} API key`}
                            onClick={() =>
                              setApiKeyChanges((current) => ({
                                ...current,
                                [keyedId]: null,
                              }))
                            }
                          >
                            Remove session key
                          </button>
                        )}
                      {pendingKey === null && (
                        <span className="credential-pending">
                          Session key will be removed.
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="settings-security-note">
                API keys are never written to Quorum’s SQLite database. Use
                environment variables for persistent credentials.{" "}
                {searchlessPolicyNote(policies)}
              </p>
            </div>

            {error && (
              <div className="settings-error" role="alert">
                {error}
              </div>
            )}
            {!selectedProviderReady && enabled && (
              <div className="settings-error" role="alert">
                Configure {providerLabel(settings, provider)} before selecting
                it.
              </div>
            )}
            {saved && !error && (
              <div className="settings-saved" role="status">
                <Check size={14} />
                Search settings saved.
              </div>
            )}
            {warning && (
              <div className="settings-warning" role="status">
                {warning}
              </div>
            )}

            <footer className="settings-actions">
              <button
                className="settings-cancel"
                type="button"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="settings-save"
                type="submit"
                disabled={!canSave}
              >
                {saving ? (
                  <>
                    <LoaderCircle className="spin" size={14} />
                    Saving…
                  </>
                ) : (
                  "Save settings"
                )}
              </button>
            </footer>
          </form>
        ) : null}

        {error && !settings && (
          <div className="settings-error settings-load-error" role="alert">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
