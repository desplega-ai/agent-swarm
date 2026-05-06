type Props = {
  count: number;
  format?: "plain" | "star";
  className?: string;
};

export function StarCount({ count, format = "plain", className }: Props) {
  const formatted = count.toLocaleString();
  if (format === "star") {
    return <span className={className}>★ {formatted}</span>;
  }
  return <span className={className}>{formatted}</span>;
}
