"use client";

import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLanguage } from "@/lib/language-context";
import { notificationText } from "@/lib/text/notifications";
import { readCachedUserKey } from "@/lib/notifications/client";
import {
  currentPermission,
  detectPushSupport,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  fetchPushServerState,
  syncPushDevice,
} from "@/lib/notifications/push-client";

type PanelState = "checking" | "on" | "off" | "unsupported" | "needs_install" | "denied" | "unavailable" | "paused" | "error";

// Compact per-device push switch shown at the top of the notification center (every staff member
// manages only their own device). Permission is requested only from the "turn on" click.
function Panel() {
  const { lang } = useLanguage();
  const t = notificationText[lang].push;
  const [state, setState] = useState<PanelState>("checking");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const publicKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const check = useCallback(async () => {
    const generation = ++generationRef.current;
    const current = () => generation === generationRef.current;
    const support = detectPushSupport();
    if (support !== "supported") { setState(support); return; }
    const server = await fetchPushServerState();
    if (!current()) return;
    if (server === "denied" || server === "error") { setState("error"); return; }
    publicKeyRef.current = server.publicKey;
    const device = await syncPushDevice(lang);
    if (!current()) return;
    // Service switched off / not configured: never shown as "on", even if this device is registered.
    if (!server.available || !server.publicKey) { setState(device === "on" ? "paused" : "unavailable"); return; }
    if (device === "on") { setState("on"); return; }
    setState(currentPermission() === "denied" ? "denied" : "off");
  }, [lang]);

  useEffect(() => {
    queueMicrotask(() => { void check(); });
    const onUser = () => { void check(); };
    const onStorage = (event: StorageEvent) => { if (event.key === "baba_user") onUser(); };
    window.addEventListener("baba_user_updated", onUser);
    window.addEventListener("storage", onStorage);
    return () => {
      generationRef.current += 1;
      window.removeEventListener("baba_user_updated", onUser);
      window.removeEventListener("storage", onStorage);
    };
  }, [check]);

  async function turnOn() {
    const publicKey = publicKeyRef.current;
    if (busy || !publicKey) return;
    setBusy(true);
    setFailed(false);
    const userKey = readCachedUserKey();
    try {
      const result = await enablePushOnThisDevice({ publicKey, lang });
      if (readCachedUserKey() !== userKey) return;
      if (result === "on") setState("on");
      else if (result === "denied") setState(currentPermission() === "denied" ? "denied" : "off");
      else if (result === "unsupported" || result === "needs_install" || result === "unavailable") setState(result);
      else if (result === "error") setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await disablePushOnThisDevice();
      if (result === "off") setState(!publicKeyRef.current ? "unavailable" : currentPermission() === "denied" ? "denied" : "off");
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const pill = state === "on" ? styles.pillOn : state === "off" || state === "checking" ? styles.pillOff : styles.pillWarn;

  return (
    <section style={styles.card} data-testid="push-device-panel" data-state={state} aria-live="polite">
      <div style={styles.row}>
        <span style={styles.title}>{t.title}</span>
        <span style={{ ...styles.pill, ...pill }}>{t.state[state]}</span>
        <span style={styles.spacer} />
        {state === "off" ? (
          <button type="button" style={styles.primaryButton} disabled={busy} onClick={() => void turnOn()}>
            {busy ? t.working : t.turnOn}
          </button>
        ) : null}
        {state === "on" || state === "paused" ? (
          <button type="button" style={styles.secondaryButton} disabled={busy} onClick={() => void turnOff()}>
            {busy ? t.working : t.turnOff}
          </button>
        ) : null}
      </div>
      <p style={styles.hint}>{failed ? t.hint.error : t.hint[state]}</p>
    </section>
  );
}

class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn("Push device panel disabled", (error as Error)?.name); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function PushDeviceSettings() {
  return (
    <PanelBoundary>
      <Panel />
    </PanelBoundary>
  );
}

const styles = {
  card: {
    background: "#fff", border: "1px solid #d8dce3", borderRadius: 14, padding: "10px 12px", marginBottom: 12,
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)", minWidth: 0,
  },
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: { fontSize: 14, fontWeight: 800, color: "#111827" },
  pill: { fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" },
  pillOn: { background: "#ecfdf5", color: "#047857", border: "1px solid #a7f3d0" },
  pillOff: { background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb" },
  pillWarn: { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a" },
  spacer: { flex: 1 },
  hint: { margin: "6px 0 0", fontSize: 12, color: "#6b7280", lineHeight: 1.5, wordBreak: "break-word" },
  primaryButton: {
    border: 0, borderRadius: 10, padding: "7px 12px", background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid #d1d5db", borderRadius: 10, padding: "7px 12px", background: "#fff", color: "#111827",
    fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProperties>;
