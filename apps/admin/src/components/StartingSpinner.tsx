import { useEffect, useState } from 'react';
import { BlinkingOwl } from './widgets/BlinkingOwl';

/**
 * The boot screen, matching the desktop's (apps/desktop/src/renderer/App.tsx).
 * Lives in its own module here because the web App.tsx is a router shell
 * rather than the desktop's single-screen switch.
 *
 * The only difference is the absence of MacDragOverlay — that exists to give
 * the frameless macOS window something to drag by, which a browser tab does
 * not need.
 */

// Cosmetic techy "boot log" cycled under the owl while the app starts.
const OWL_BOOT_LINES = [
  'waking the owl',
  'ruffling feathers',
  'scanning the perch',
  'syncing pull requests',
  'sharpening talons',
  'engaging night vision',
];

export function StartingSpinner() {
  const [line, setLine] = useState(0);
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const dotId = window.setInterval(() => setDots((d) => (d + 1) % 4), 420);
    const lineId = window.setInterval(
      () => setLine((l) => (l + 1) % OWL_BOOT_LINES.length),
      1600
    );
    return () => {
      window.clearInterval(dotId);
      window.clearInterval(lineId);
    };
  }, []);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="flex flex-col items-center select-none">
        <BlinkingOwl />

        {/* Sweeping scan bar — the "techy" tell. */}
        <div className="mt-4 h-px w-44 overflow-hidden rounded-full bg-border/60">
          <div className="owl-scan-bar h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent" />
        </div>

        <p
          aria-label="Starting"
          className="mt-3 font-mono text-xs text-muted-foreground"
        >
          <span className="text-primary">&gt;</span> {OWL_BOOT_LINES[line]}
          <span className="text-primary">{'.'.repeat(dots)}</span>
          <span className="owl-caret ml-0.5 text-primary">▋</span>
        </p>
      </div>
    </div>
  );
}
