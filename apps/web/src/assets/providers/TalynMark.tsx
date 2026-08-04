/**
 * The Talyn owl, as the provider mark for Talyn Fleet.
 *
 * A vendor logo for every provider except this one, which has no vendor — the
 * run happens on hardware we own, so the mark is ours. It replaces the server
 * rack that stood in for it: a rack says "self-hosted", which is a deployment
 * detail, where the brand says whose fleet it is.
 *
 * # Why a component and not a data URI
 *
 * Every other provider is an `<img>` because a vendor's logo has fixed colours.
 * This one has to be BLACK, and "black" in an app with a dark theme means the
 * foreground colour, not `#000` — which would be a mark that vanishes into the
 * background for anyone running dark mode. An `<img>` cannot inherit that; a
 * `currentColor` SVG can, which is exactly why the marketing `OwlMark` is built
 * the same way.
 *
 * # Why the stroke is heavier than the marketing mark's
 *
 * Marketing draws this at 28px and up with `stroke-width: 3.2`. This renders at
 * **14px**, where 3.2 on a 64-unit viewBox comes out under a device pixel and
 * the eyes silt up into grey dots. 4.2 holds the two eyes, the beak sweep and
 * the belly curve apart at 14px and still reads as the same bird at 64. Checked
 * at 14/16/20/32/64 against 3.2 and 5.2 — the latter closes the eyes in.
 *
 * The geometry is otherwise identical to `apps/marketing/components/brand/
 * Logo.tsx`. If the brand mark changes, change it here too; they are the same
 * bird and there is no build step that would tell you they had drifted.
 */
export function TalynOwlMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={4.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* head dome */}
      <path d="M18 22 C 21 10 43 10 46 22" />
      {/* wings */}
      <path d="M16 25 C 11 33 11 46 18 53" />
      <path d="M48 25 C 53 33 53 46 46 53" />
      {/* eyes */}
      <circle cx="25.5" cy="30" r="4.4" />
      <circle cx="38.5" cy="30" r="4.4" />
      {/* beak — a talon-like sweep */}
      <path d="M29 37 L 32 43 L 35 37" />
      {/* belly */}
      <path d="M27 49 Q 32 52 37 49" />
    </svg>
  );
}
