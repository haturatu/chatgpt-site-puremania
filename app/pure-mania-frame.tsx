export default function PureManiaFrame() {
  return (
    <iframe
      title="Pure Mania"
      src="/static/index.html"
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100dvh", border: 0, display: "block" }}
    />
  );
}
