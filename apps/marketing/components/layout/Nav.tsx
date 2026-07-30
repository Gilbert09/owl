"use client";

import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { nav, site } from "@/lib/content";
import { cn } from "@/lib/utils";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-line bg-paper/80 backdrop-blur-xl"
          : "border-b border-transparent"
      )}
    >
      <nav className="container relative flex h-16 items-center justify-between">
        <a href="/#top" aria-label="Talyn home">
          <Logo />
        </a>

        {/* lg (not md): the link row is absolutely centered, so at md widths
            it collides with the right-side buttons — hamburger until lg. */}
        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 lg:flex">
          {nav.map((item) => (
            <a
              key={item.href}
              href={`/${item.href}`}
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink-600 transition-colors hover:text-ink"
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 lg:flex">
          <a href={site.githubUrl} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm">
              GitHub
            </Button>
          </a>
          <a href={site.appUrl}>
            <Button variant="secondary" size="sm">
              Open app
            </Button>
          </a>
          <DownloadButton size="sm">Download</DownloadButton>
        </div>

        <button
          className="rounded-lg p-2 text-ink lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open && (
        <div className="border-t border-line bg-paper/95 px-6 py-4 backdrop-blur-xl lg:hidden">
          <div className="flex flex-col gap-1">
            {nav.map((item) => (
              <a
                key={item.href}
                href={`/${item.href}`}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm text-ink-600 hover:bg-ink/[0.04]"
              >
                {item.label}
              </a>
            ))}
            <div onClick={() => setOpen(false)} className="mt-2 flex flex-col gap-2">
              <a href={site.appUrl} className="w-full">
                <Button variant="secondary" size="md" className="w-full">
                  Open app
                </Button>
              </a>
              {/* No hardcoded platform — DownloadButton resolves it at runtime
                  now that macOS, Windows and Linux all ship. */}
              <DownloadButton size="md" className="w-full" />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
