/** Albireo is a double star: one gold, one blue. */
export function Logo(props: { size?: number }) {
  const size = () => props.size ?? 20;
  return (
    <svg width={size()} height={size()} viewBox="0 0 24 24" role="img" aria-label="Albireo">
      <circle cx="8.5" cy="12" r="6" fill="var(--gold)" />
      <circle cx="15.5" cy="12" r="6" fill="var(--blue)" fill-opacity="0.9" />
    </svg>
  );
}
