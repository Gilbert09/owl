"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { Badge } from "@/components/ui/badge";
import { GridBackground } from "@/components/ui/GridBackground";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { site, hero } from "@/lib/content";

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-28 pb-16 sm:pt-32">
      <GridBackground />
      {/* scan-bar glow echoing the app boot screen */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-24 h-px w-[60%] -translate-x-1/2 animate-scan bg-gradient-to-r from-transparent via-clay/40 to-transparent"
      />

      <div className="container relative">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="mx-auto max-w-3xl text-center"
        >
          <div className="mb-6 flex justify-center">
            <Badge dot>{hero.badge}</Badge>
          </div>

          {/* Each part on its own line so a free-flowing wrap can't break it
              mid-phrase ("Wake up to green / PRs.") at laptop widths. */}
          <h1 className="font-display text-5xl font-semibold leading-[1.04] tracking-tight text-ink sm:text-7xl">
            <span className="block">{hero.titleLead}</span>
            <span className="block text-clay">{hero.titleAccent}</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-ink-500">
            {hero.sub}
          </p>

          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <DownloadButton size="lg">{hero.primaryCta}</DownloadButton>
            {/* The browser app is a peer of the download, not a footnote:
                it is the whole product with nothing to install, and the
                only option for anyone who can't or won't install one. */}
            <a href={site.appUrl}>
              <Button variant="secondary" size="lg">
                {hero.webCta}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </a>
          </div>

          <p className="mt-3 font-mono text-xs text-ink-400">{hero.microtrust}</p>

          <a
            href="#how"
            className="mt-4 inline-block text-sm text-ink-500 underline underline-offset-4 hover:text-ink"
          >
            {hero.secondaryCta}
          </a>
        </motion.div>

        {/* mt-10 (was 16): keep the top of the screenshot above the fold on a
            laptop viewport — the "most useful bit" shouldn't need a scroll. */}
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.15, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="relative mx-auto mt-10 max-w-5xl"
        >
          <ScreenshotPlaceholder shot="dashboard" title="Talyn — My PRs" />
        </motion.div>
      </div>
    </section>
  );
}
