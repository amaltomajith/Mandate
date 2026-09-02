"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MandateMark } from "@/components/brand/MandateMark";

/**
 * Replaces the card-expanding nav that was here first.
 *
 * That one dropped a 216px panel of three tinted cards over the hero to show
 * nine links. On a page whose whole argument is restraint it was the loudest
 * thing on screen, and it hid the headline to say things that fit on one line.
 *
 * This is the same links in a bar. It starts transparent over the shader and
 * earns its background only once you have scrolled past the hero, so nothing
 * sits on top of the opening statement until there is something behind it to
 * separate from.
 */

const LINKS = [
  { label: "How it works", href: "#how" },
  { label: "Policy", href: "#rules" },
  { label: "Protocol", href: "#protocol" },
  { label: "Architecture", href: "/architecture.html", external: true },
];

export function SiteNav({ signedIn }: { signedIn: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // 24px rather than 0 so a trackpad's one-pixel jitter at the top of the
    // page does not flicker the background on and off.
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A menu that stays open behind you after a jump link is a menu you have to
  // dismiss twice.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [open]);

  const cta = signedIn
    ? { label: "Dashboard", href: "/dashboard" }
    : { label: "Get started", href: "/sign-up" };

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 transition-colors duration-300"
      style={{
        background: scrolled || open ? "rgba(5,5,7,0.72)" : "transparent",
        backdropFilter: scrolled || open ? "blur(16px) saturate(140%)" : "none",
        WebkitBackdropFilter: scrolled || open ? "blur(16px) saturate(140%)" : "none",
        borderBottom: `1px solid ${scrolled || open ? "var(--panel-border)" : "transparent"}`,
      }}
    >
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Mandate, home">
          <MandateMark size={24} />
          <span className="text-[15px] font-semibold tracking-[-0.015em]">Mandate</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              {...(l.external ? { target: "_blank", rel: "noopener" } : {})}
              className="text-[13.5px] transition-colors hover:text-[var(--foreground)]"
              style={{ color: "var(--muted)" }}
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={cta.href}
            className="rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition-[filter] hover:brightness-115"
            style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)" }}
          >
            {cta.label}
          </Link>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="flex h-9 w-9 flex-col items-center justify-center gap-[5px] rounded-lg md:hidden"
          >
            <span
              className="block h-[1.5px] w-[18px] rounded-full bg-current transition-transform duration-200"
              style={{ transform: open ? "translateY(3.25px) rotate(45deg)" : undefined }}
            />
            <span
              className="block h-[1.5px] w-[18px] rounded-full bg-current transition-transform duration-200"
              style={{ transform: open ? "translateY(-3.25px) rotate(-45deg)" : undefined }}
            />
          </button>
        </div>
      </nav>

      {/* Grid-rows 0fr → 1fr collapses to the content's own height without
          anyone measuring it, which is what the old nav needed JavaScript and a
          temporarily-unhidden clone to work out. */}
      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 md:hidden"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0">
          <div className="flex flex-col gap-1 px-6 pb-4 sm:px-8">
            {LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                {...(l.external ? { target: "_blank", rel: "noopener" } : {})}
                onClick={() => setOpen(false)}
                tabIndex={open ? 0 : -1}
                className="rounded-lg py-2.5 text-[15px] transition-colors hover:text-[var(--foreground)]"
                style={{ color: "var(--muted)" }}
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
