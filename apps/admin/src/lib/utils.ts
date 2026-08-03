import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// NOTE: the desktop's lib/utils.ts also exports `isMacDesktop`, which gates
// the frameless-window drag strips (macOS hidden title bar). It is always
// false in a browser, so rather than carry a constant that is dead by
// construction, the elements it gated are dropped from the fork outright —
// they are in-flow, so keeping them would mean dead vertical space.
