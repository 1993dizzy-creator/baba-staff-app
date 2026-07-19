"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fetchBarApi, handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { keepingNewText } from "@/lib/text/bar-keeping-new";

export type KeepingProduct = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  code: string | null;
  category: string | null;
  category_vi: string | null;
};

export default function KeepingProductAutocomplete({
  lang,
  disabled,
  onSelect,
  initialValue = "",
}: {
  lang: "ko" | "vi";
  disabled?: boolean;
  onSelect: (product: KeepingProduct | null, name: string) => void;
  initialValue?: string;
}) {
  const text = keepingNewText[lang];
  const listId = useId();
  const requestId = useRef(0);
  const [query, setQuery] = useState(initialValue);
  const [items, setItems] = useState<KeepingProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setItems([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetchBarApi(`/api/bar/keeping-products?q=${encodeURIComponent(normalized)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (await handleBarApiUnauthorized(response)) return;
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (currentRequest !== requestId.current) return;
        setItems(result.items ?? []);
        setOpen(true);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (currentRequest === requestId.current) {
          setError(text.productSearchError);
          setItems([]);
          setOpen(true);
        }
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    }, 280);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, text.productSearchError]);

  const displayName = (item: KeepingProduct) =>
    (lang === "vi" ? item.item_name_vi || item.item_name : item.item_name || item.item_name_vi)?.trim() || item.code || "-";
  const secondaryName = (item: KeepingProduct) => {
    const alternate = lang === "vi" ? item.item_name : item.item_name_vi;
    return [item.code, alternate && alternate !== displayName(item) ? alternate : null].filter(Boolean).join(" · ");
  };
  const chooseItem = (item: KeepingProduct) => {
    const name = displayName(item);
    setQuery(name);
    setOpen(false);
    onSelect(item, name);
  };

  return (
    <div>
      <input
        value={query}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={text.productPlaceholder}
        onFocus={() => query.trim() && setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          onSelect(null, "");
        }}
        style={inputStyle}
      />
      {loading ? <div style={messageStyle}>{text.searching}</div> : null}
      {open && !loading ? (
        <div id={listId} role="listbox" style={listStyle}>
          {error ? <div style={{ ...messageStyle, color: "#b91c1c" }}>{error}</div> : null}
          {!error && items.length === 0 ? <div style={messageStyle}>{text.noProducts}</div> : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected="false"
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => { if (event.pointerType !== "mouse") { event.preventDefault(); chooseItem(item); } }}
              onClick={() => chooseItem(item)}
              style={optionStyle}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>{displayName(item)}</span>
              {secondaryName(item) ? <small style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{secondaryName(item)}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, minHeight: 40, boxSizing: "border-box", padding: "0 11px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, outline: "none" };
const listStyle: React.CSSProperties = { maxHeight: 232, overflowY: "auto", marginTop: 5, padding: 4, border: "1px solid #d1d5db", borderRadius: 10, background: "#fff" };
const optionStyle: React.CSSProperties = { width: "100%", minHeight: 46, display: "grid", gap: 2, padding: "7px 9px", border: 0, borderRadius: 7, background: "transparent", textAlign: "left", color: "#111827", fontSize: 13 };
const messageStyle: React.CSSProperties = { padding: "9px 10px", color: "#6b7280", fontSize: 12 };
