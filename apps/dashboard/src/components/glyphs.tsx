/** Drawn marks, never emoji or font glyphs, so a verdict looks the same on every machine. */
export function CrossGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 4 L20 20 M20 4 L4 20" stroke="currentColor" strokeWidth="4" fill="none" />
    </svg>
  );
}

export function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 13 L9 19 L21 5" stroke="currentColor" strokeWidth="4" fill="none" />
    </svg>
  );
}
