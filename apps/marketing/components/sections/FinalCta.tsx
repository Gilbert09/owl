import { Reveal } from "@/components/ui/Reveal";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { EmailCapture } from "@/components/ui/EmailCapture";
import { OwlMark } from "@/components/brand/Logo";
import { site, finalCta } from "@/lib/content";

/** The closing conversion section. Carries id="download" (footer links to it)
 *  and the non-Mac waitlist — both absorbed from the removed Beta section,
 *  which duplicated this one's job. */
export function FinalCta() {
  return (
    <section id="download" className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[360px] w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-clay/[0.07] blur-[140px]"
      />
      <div className="container relative text-center">
        <Reveal>
          <OwlMark className="mx-auto h-12 w-12 animate-blink text-clay" />
          <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
            {finalCta.titleLead}
            <br />
            <span className="text-clay">{finalCta.titleAccent}</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-ink-500">{finalCta.sub}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <DownloadButton size="lg">{finalCta.cta}</DownloadButton>
            <a href={site.appUrl}>
              <Button variant="secondary" size="lg">
                Open in browser
              </Button>
            </a>
          </div>
          <div className="mx-auto mt-10 max-w-sm border-t border-line pt-6">
            <p className="text-sm text-ink-500">{finalCta.emailLabel}</p>
            <EmailCapture />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
