type ContainerProps = {
  children: React.ReactNode;
  noPaddingTop?: boolean;
  noPaddingBottom?: boolean;
};

export default function Container({
  children,
  noPaddingTop,
  noPaddingBottom,
}: ContainerProps) {
  return (
    <main
      style={{
        maxWidth: 800,
        margin: "0 auto",
        paddingTop: noPaddingTop ? 0 : 20,
        paddingBottom: noPaddingBottom ? 0 : 20,
        paddingLeft: 16,
        paddingRight: 16,
      }}
    >
      {children}
    </main>
  );
}