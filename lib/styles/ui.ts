export const ui = {
    input: {
        width: "100%",
        padding: "12px 14px",
        border: "1px solid #d1d5db",
        borderRadius: 10,
        fontSize: 14,
        outline: "none",
        boxSizing: "border-box" as const,
    },

    inputFocus: {
        border: "1px solid black",
    },

    button: {
        width: "100%",
        padding: "13px 14px",
        background: "black",
        color: "white",
        border: "1px solid black",
        borderRadius: 10,
        fontSize: 15,
        fontWeight: 600,
        cursor: "pointer",
        transition: "all 0.15s ease",
        textDecoration: "none",
        display: "inline-block",
        textAlign: "center" as const,
        boxSizing: "border-box" as const,
    },

    subButton: {
        width: "100%",
        padding: "13px 14px",
        background: "#f5f5f5",
        color: "black",
        border: "1px solid #ddd",
        borderRadius: 10,
        fontSize: 15,
        fontWeight: 600,
        cursor: "pointer",
        transition: "all 0.15s ease",
        textDecoration: "none",
        display: "inline-block",
        textAlign: "center" as const,
        boxSizing: "border-box" as const,
    },

    card: {
        background: "white",
        border: "1px solid #dcdfe4",
        borderRadius: 20,
        boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
    },

    filterBox: {
        padding: 16,
        marginBottom: 16,
        border: "1px solid #e3e5e8",
        borderRadius: 12,
        background: "#f7f7f8",
    },

    pageTitle: {
        fontSize: 32,
        fontWeight: "bold" as const,
        marginBottom: 20,
    },

    sectionTitle: {
        marginBottom: 16,
        fontSize: 20,
        fontWeight: "bold" as const,
    },

    cardRow: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
    },

    metaText: {
        fontSize: 12,
        color: "#6b7280",
        lineHeight: 1.4,
    },

    badgeMini: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 30,
        height: 18,
        padding: "0 6px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        color: "#fff",
    },
    detailGrid: {
        display: "grid",
        gridTemplateColumns: "88px 1fr",
        rowGap: 4,
        columnGap: 10,
        alignItems: "start",
    },

    detailLabel: {
        fontSize: 12,
        color: "#6b7280",
        fontWeight: 700,
        lineHeight: 1.5,
    },

    detailValue: {
        fontSize: 13,
        color: "#111827",
        lineHeight: 1.5,
        wordBreak: "break-word" as const,
    },
};