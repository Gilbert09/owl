"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import { capture } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const REPO = "Gilbert09/talyn";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

type Release = {
  assets?: Array<{ name: string; browser_download_url: string }>;
};

type PlatformKey = "mac" | "windows" | "linux";

type Platform = {
  key: PlatformKey;
  /** Substituted into the `{platform}` token in CTA copy. */
  label: string;
  /**
   * Asset name patterns, most-preferred first. electron-builder emits
   * `Talyn-<version>-arm64.dmg` / `Talyn Setup <version>.exe` /
   * `Talyn-<version>.AppImage` — see apps/desktop/package.json `build`.
   */
  patterns: RegExp[];
};

const PLATFORMS: Record<PlatformKey, Platform> = {
  // arm64 first: every Mac from 2020+ is Apple Silicon, and the browser can't
  // tell us the CPU. An Intel user who lands on the arm64 build gets a clear
  // "can't be opened" error rather than a silent mis-install, and the
  // releases page (the fallback below) carries both.
  mac: { key: "mac", label: "Mac", patterns: [/arm64.*\.dmg$/i, /\.dmg$/i] },
  windows: { key: "windows", label: "Windows", patterns: [/\.exe$/i] },
  linux: { key: "linux", label: "Linux", patterns: [/\.AppImage$/i] },
};

/**
 * Best-effort client-side OS sniff. Deliberately defaults to Mac: it's the
 * only platform that shipped before this button learned about the others, so
 * an unknown UA behaves exactly as it did before.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return PLATFORMS.mac;
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`;
  // Test Windows/Android before Linux — Android UAs contain "Linux".
  if (/Win(dows|32|64)/i.test(ua)) return PLATFORMS.windows;
  if (/Android/i.test(ua)) return PLATFORMS.mac;
  if (/Linux|X11/i.test(ua)) return PLATFORMS.linux;
  return PLATFORMS.mac;
}

function pickAsset(
  release: Release | null | undefined,
  platform: Platform
): string | null {
  const assets = release?.assets ?? [];
  for (const pattern of platform.patterns) {
    const hit = assets.find((a) => pattern.test(a.name));
    if (hit) return hit.browser_download_url;
  }
  return null;
}

/**
 * Resolve the installer for `platform` via the public GitHub API. Prefer the
 * latest STABLE release (`/releases/latest` excludes pre-releases — nightlies
 * ship as pre-releases and shouldn't be a visitor's first install); fall back
 * to the newest release of any kind while no stable tag exists yet, then to
 * null so the caller can open the releases page.
 */
async function resolveLatestAsset(platform: Platform): Promise<string | null> {
  const headers = { Accept: "application/vnd.github+json" };
  try {
    const stable = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers }
    );
    if (stable.ok) {
      const url = pickAsset((await stable.json()) as Release, platform);
      if (url) return url;
    }
  } catch {
    /* fall through to the newest-release fallback */
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=1`,
      { headers }
    );
    if (!res.ok) return null;
    const releases = (await res.json()) as Release[];
    return pickAsset(releases?.[0], platform);
  } catch {
    return null;
  }
}

export function DownloadButton({
  children,
  size = "lg",
  variant = "primary",
  className,
}: {
  children?: React.ReactNode;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  // Resolved after mount, never during render: the server has no navigator,
  // so sniffing inline would hydrate-mismatch. Until then every visitor sees
  // the Mac label, which is what the page rendered before this existed.
  const [platform, setPlatform] = useState<Platform>(PLATFORMS.mac);
  useEffect(() => setPlatform(detectPlatform()), []);

  const onClick = async () => {
    if (loading) return;
    capture("download_click", { platform: platform.key });
    setLoading(true);
    const url = await resolveLatestAsset(platform);
    // Navigate to the installer (triggers download). When there's no asset
    // for this platform — a release that predates cross-platform builds, or
    // an OS we don't ship — fall back to the releases page, which lists
    // every artifact.
    window.location.href = url ?? RELEASES_URL;
    // Leave the spinner up briefly; the navigation takes over.
    setTimeout(() => setLoading(false), 4000);
  };

  // CTA copy lives in lib/content.ts and carries a `{platform}` token so the
  // marketing voice stays in one place while the OS name stays a runtime fact.
  const label =
    typeof children === "string"
      ? children.replace(/\{platform\}/g, platform.label)
      : (children ?? `Download for ${platform.label}`);

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <Download className="h-5 w-5" />
      )}
      {label}
    </button>
  );
}
