import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';

// The owl, drawn so only the eyes line swaps on a blink (same character
// width, so the ASCII never jitters). `O   O` open → `-   -` shut.
function owlArt(eyes: string): string {
  return [
    '  .-"""-.',
    ` ( ${eyes} )`,
    ' (   v   )',
    "  ) '-' (",
    ' (_/   \\_)',
  ].join('\n');
}

/** Owls blink in quick bursts, then hold their gaze — mimic that, leak-free. */
export function useOwlBlink(): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    const timers: number[] = [];
    let alive = true;
    const wink = (then: () => void) => {
      setBlinking(true);
      timers.push(
        window.setTimeout(() => {
          setBlinking(false);
          timers.push(window.setTimeout(then, 110));
        }, 130)
      );
    };
    const loop = () => {
      if (!alive) return;
      const hold = 1700 + Math.floor(Math.random() * 2200);
      timers.push(
        window.setTimeout(() => {
          // Every so often a double blink — owls do it, and it reads as alive.
          if (Math.random() < 0.35) wink(() => wink(loop));
          else wink(loop);
        }, hold)
      );
    };
    loop();
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
  return blinking;
}

/** The ASCII owl mascot, blinking. Used on the boot and login screens. */
export function BlinkingOwl({ className }: { className?: string }) {
  const blinking = useOwlBlink();
  return (
    <pre
      aria-hidden
      className={cn(
        // text-left guards against centered ancestors: text-align inherits
        // into <pre>, and centering each line independently wrecks the art.
        'owl-glow text-left font-mono text-primary leading-[1.1] text-[15px] sm:text-base',
        className
      )}
    >
      {owlArt(blinking ? '-   -' : 'O   O')}
    </pre>
  );
}
