/**
 * The word, as keys. One of them has come loose, and tips right over if you touch it, because of course it does. Purely decorative: the real name is always
 * in the text beside it, and these are not controls, so they are hidden from assistive tech and from the keyboard.
 */
export function KeycapWord({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`caps caps--${size}`} aria-hidden="true">
      {["M", "U", "R", "P", "H", "Y"].map((letter) => (
        <span key={letter} className={letter === "Y" ? "cap cap--loose" : "cap"}>
          {letter}
        </span>
      ))}
    </span>
  );
}

export function MarkCap() {
  return (
    <span className="cap cap--mark" aria-hidden="true">
      M
    </span>
  );
}
