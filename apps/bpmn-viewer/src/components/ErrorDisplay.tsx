interface ErrorDisplayProps {
  error: string;
}

export function ErrorDisplay({ error }: ErrorDisplayProps) {
  return (
    <div className="error-display">
      <h3>Error</h3>
      <pre>{error}</pre>
    </div>
  );
}
