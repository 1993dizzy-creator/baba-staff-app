"use client";

import { ui } from "@/lib/styles/ui";

type ChangeItem = {
    label: string;
    before?: string;
    after: string;
    color?: string;
};

type Props = {
    group: any;
    isOpen: boolean;
    lang: string;
    noteText?: string;
    partLabel: string;
    itemName: string;
    categoryName: string;
    detailLabel: string;
    closeLabel: string;
    deleteLabel: string;
    isMaster?: boolean;
    onToggle?: () => void;
    onDeleteSingleLog?: (logId: number) => void;
    getActionBadge: (action: string) => string;
    getActionColor: (action: string) => string;
    formatDateTime: (value: string) => string;
    getLogChanges: (log: any, lang: string) => ChangeItem[];
};

export default function InventoryLogGroupCard({
    group,
    isOpen,
    lang,
    noteText = "-",
    partLabel,
    itemName,
    categoryName,
    detailLabel,
    closeLabel,
    deleteLabel,
    isMaster = false,
    onToggle,
    onDeleteSingleLog,
    getActionBadge,
    getActionColor,
    formatDateTime,
    getLogChanges,
}: Props) {
    const log = group.latest;

    return (
        <div
            style={{
                ...ui.card,
                padding: "8px 10px",
                borderLeft: `4px solid ${getActionColor(log.action)}`,
                background: "#fff",
            }}
        >
            <div style={ui.cardRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                        }}
                    >
                        <span
                            style={{
                                ...ui.badgeMini,
                                background: getActionColor(log.action),
                            }}
                        >
                            {getActionBadge(log.action)}
                        </span>

                        <span
                            style={{
                                fontSize: 14,
                                fontWeight: 700,
                                lineHeight: 1.2,
                                color: "#111827",
                            }}
                        >
                            {[log.code ? `[${log.code}]` : "", itemName]
                                .filter(Boolean)
                                .join(" ")}
                        </span>
                    </div>

                    <div style={ui.metaText}>
                        {[partLabel, categoryName].join(" · ")}
                    </div>

                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 13,
                            color: "#4b5563",
                            wordBreak: "break-word",
                        }}
                    >
                        {noteText || "-"}
                    </div>
                </div>

                <div
                    style={{
                        textAlign: "right",
                        flexShrink: 0,
                        marginLeft: 10,
                    }}
                >
                    <div style={ui.metaText}>
                        {log.created_at ? formatDateTime(log.created_at) : "-"}
                    </div>
                    <div style={ui.metaText}>{log.actor_name || "-"}</div>

                    {onToggle && (
                        <button
                            type="button"
                            onClick={onToggle}
                            style={{
                                ...ui.subButton,
                                width: "auto",
                                minWidth: 72,
                                padding: "6px 10px",
                                marginTop: 6,
                                fontWeight: 700,
                            }}
                        >
                            {isOpen ? closeLabel : detailLabel}
                        </button>
                    )}
                </div>
            </div>

            {isOpen && (
                <div
                    style={{
                        marginTop: 10,
                        paddingTop: 10,
                        borderTop: "1px solid #eee",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                    }}
                >
                    {group.logs.map((history: any) => {
                        const changes = getLogChanges(history, lang);

                        return (
                            <div
                                key={history.id}
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 10,
                                    padding: "8px 0",
                                    borderBottom: "1px solid #f3f4f6",
                                }}
                            >
                                <div
                                    style={{
                                        minWidth: 0,
                                        flex: 1,
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 6,
                                    }}
                                >
                                    {changes.map((change, index) => (
                                        <div
                                            key={`${history.id}-${index}`}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 8,
                                                minWidth: 0,
                                            }}
                                        >
                                            <span
                                                style={{
                                                    ...ui.badgeMini,
                                                    background: "#111827",
                                                    flexShrink: 0,
                                                }}
                                            >
                                                {change.label}
                                            </span>

                                            <div
                                                style={{
                                                    fontSize: 13,
                                                    fontWeight: 700,
                                                    wordBreak: "break-word",
                                                    minWidth: 0,
                                                }}
                                            >
                                                {change.before ? (
                                                    <>
                                                        <span style={{ color: "#111827" }}>
                                                            {change.before}
                                                        </span>
                                                        <span style={{ color: "#9ca3af" }}>
                                                            {" "}
                                                            →{" "}
                                                        </span>
                                                        <span
                                                            style={{
                                                                color:
                                                                    change.color || "#111827",
                                                            }}
                                                        >
                                                            {change.after}
                                                        </span>
                                                    </>
                                                ) : (
                                                    <span
                                                        style={{
                                                            color:
                                                                change.color || "#111827",
                                                        }}
                                                    >
                                                        {change.after}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div
                                    style={{
                                        textAlign: "right",
                                        flexShrink: 0,
                                        fontSize: 12,
                                        color: "#6b7280",
                                        whiteSpace: "nowrap",
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "flex-end",
                                        gap: 6,
                                    }}
                                >
                                    <div>
                                        {history.created_at
                                            ? formatDateTime(history.created_at)
                                            : "-"}
                                    </div>
                                    <div>{history.actor_name || "-"}</div>

                                    {isMaster && onDeleteSingleLog && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onDeleteSingleLog(history.id)
                                            }
                                            style={{
                                                ...ui.subButton,
                                                width: "auto",
                                                minWidth: 52,
                                                padding: "4px 8px",
                                                background: "crimson",
                                                color: "white",
                                                border: "1px solid crimson",
                                                fontSize: 12,
                                                fontWeight: 700,
                                            }}
                                        >
                                            {deleteLabel}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}