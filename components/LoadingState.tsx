import styles from "./LoadingState.module.css";

type Props = {
  label: string;
  variant?: "page" | "panel" | "more";
};

export default function LoadingState({ label, variant = "panel" }: Props) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={`${styles.root} ${styles[variant]}`}>
      <span className={styles.content}>
        <span className={styles.spinner} aria-hidden="true" />
        <span>{label}</span>
      </span>
    </div>
  );
}
