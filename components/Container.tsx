type ContainerProps = {
  children: React.ReactNode;
};

export default function Container({ children }: ContainerProps) {
  return (
    <main
      style={{
        maxWidth: 800,
        margin: "20px auto",
        padding: "20px 20px 90px",
      }}
    >
      {children}
    </main>
  );
}