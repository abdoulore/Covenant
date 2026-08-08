/** Inline SVG icon by name, resolving the symbol set mounted in index.html. */
export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg className={`ic ${className}`.trim()} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
