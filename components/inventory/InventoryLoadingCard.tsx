import type { CSSProperties } from "react";
import { commonText } from "@/lib/text";
import { ui } from "@/lib/styles/ui";
import styles from "./InventoryLoadingCard.module.css";

type Props = {
    lang: "ko" | "vi";
    minHeight?: CSSProperties["minHeight"];
    testId?: string;
    marginBottom?: number;
};

export default function InventoryLoadingCard({ lang, minHeight = 180, testId, marginBottom = 0 }: Props) {
    return (
        <div data-testid={testId} role="status" aria-live="polite" aria-atomic="true"
            className={styles.card} style={{ ...ui.card, minHeight, marginBottom }}>
            <span className={styles.content}>
                <span className={styles.spinner} aria-hidden="true" />
                <span>{commonText[lang].loading}</span>
            </span>
        </div>
    );
}
