"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs bypass the public Next image optimizer */

import { useEffect, useRef } from "react";

type ImagePreviewModalProps = {
  src: string;
  alt: string;
  closeLabel: string;
  onClose: () => void;
};

export default function ImagePreviewModal({
  src,
  alt,
  closeLabel,
  onClose,
}: ImagePreviewModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        padding: 16,
        background: "rgba(0, 0, 0, 0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 960,
          maxHeight: "90vh",
          padding: 12,
          borderRadius: 16,
          background: "#ffffff",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 10,
          }}
        >
          <strong
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 14,
            }}
          >
            {alt}
          </strong>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            style={{
              minWidth: 44,
              minHeight: 44,
              border: "1px solid #d1d5db",
              borderRadius: 10,
              background: "#ffffff",
              color: "#111827",
              fontSize: 18,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            position: "relative",
            width: "100%",
            height: "min(72vh, 720px)",
            background: "#f3f4f6",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {/* Signed private Storage URLs are displayed directly and expire after one hour. */}
          <img
            src={src}
            alt={alt}
            style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }}
          />
        </div>
      </div>
    </div>
  );
}
