export default function Loading() {
  return <div aria-label="Loading" style={{ display: "grid", gap: 10 }}>
    {[0, 1, 2].map((item) => <div key={item} style={{ minHeight: 112, border: "1px solid #dcdfe4", borderRadius: 20, background: "#f3f4f6" }} />)}
  </div>;
}
