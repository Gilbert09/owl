/**
 * A page that exists so its route and its nav entry can be wired up and
 * tested before the view behind it is built.
 *
 * Temporary by construction: every one of these is replaced by a real page in
 * the fleet and product steps. It says what it is rather than pretending to
 * load, so nobody mistakes an unbuilt page for a broken one.
 */
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-6">
      <h1 className="font-display text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
    </div>
  );
}
