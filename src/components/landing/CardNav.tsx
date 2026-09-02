"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { gsap } from "gsap";
import styles from "./CardNav.module.css";

/**
 * Adapted from the React Bits CardNav. Four changes, each for a reason:
 *
 *   - The logo is a ReactNode, not an image URL. This app already has a brand
 *     mark as an SVG component; writing it out to a file just to pass a `src`
 *     would leave two copies of the logo to keep in step.
 *   - Links route through `next/link` so an in-app destination is a client
 *     navigation rather than a full reload; anything starting with `http` or
 *     `#` stays a plain anchor.
 *   - The arrow icon is drawn inline. `react-icons` is not a dependency here
 *     and pulling one in for a single 16px glyph is not a trade worth making.
 *   - The hamburger is a real <button>, not a div wearing role="button", so it
 *     gets keyboard and focus behaviour from the platform instead of from
 *     hand-written key handlers.
 */

export interface CardNavLink {
  label: string;
  href: string;
  ariaLabel?: string;
}

export interface CardNavItem {
  label: string;
  bgColor: string;
  textColor: string;
  links: CardNavLink[];
}

export interface CardNavProps {
  logo: ReactNode;
  items: CardNavItem[];
  ctaLabel: string;
  ctaHref: string;
  ease?: string;
  baseColor?: string;
  menuColor?: string;
  className?: string;
}

/** Desktop panel height. The reference uses 260, which is airy for cards
 *  carrying three short links each -- the label sits at the top, the links are
 *  pushed to the bottom by `margin-top: auto`, and the gap between them reads
 *  as something failed to load. Sized to the content instead.
 *
 *  The mobile height is measured rather than declared, because a stacked column
 *  of cards has no height anyone can hardcode. */
const DESKTOP_HEIGHT = 216;

function ArrowIcon() {
  return (
    <svg
      className={styles.linkIcon}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}

export default function CardNav({
  logo,
  items,
  ctaLabel,
  ctaHref,
  ease = "power3.out",
  baseColor = "rgba(13, 16, 24, 0.72)",
  menuColor = "var(--foreground)",
  className = "",
}: CardNavProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement[]>([]);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const expandedRef = useRef(false);

  const calculateHeight = () => {
    const navEl = navRef.current;
    const contentEl = contentRef.current;
    if (!navEl || !contentEl) return DESKTOP_HEIGHT;

    if (!window.matchMedia("(max-width: 768px)").matches) return DESKTOP_HEIGHT;

    // Measured with the panel temporarily made real: it is `visibility: hidden`
    // and absolutely positioned while closed, and neither of those states has a
    // scrollHeight worth reading.
    const prev = {
      visibility: contentEl.style.visibility,
      pointerEvents: contentEl.style.pointerEvents,
      position: contentEl.style.position,
      height: contentEl.style.height,
    };
    contentEl.style.visibility = "visible";
    contentEl.style.pointerEvents = "auto";
    contentEl.style.position = "static";
    contentEl.style.height = "auto";

    const contentHeight = contentEl.scrollHeight;

    Object.assign(contentEl.style, prev);
    return 60 + contentHeight + 16;
  };

  const createTimeline = () => {
    const navEl = navRef.current;
    if (!navEl) return null;
    const cards = cardsRef.current.filter(Boolean);

    gsap.set(navEl, { height: 60, overflow: "hidden" });
    gsap.set(cards, { y: 50, opacity: 0 });

    const tl = gsap.timeline({ paused: true });
    tl.to(navEl, { height: calculateHeight, duration: 0.4, ease });
    tl.to(cards, { y: 0, opacity: 1, duration: 0.4, ease, stagger: 0.08 }, "-=0.1");
    return tl;
  };

  useLayoutEffect(() => {
    const tl = createTimeline();
    tlRef.current = tl;
    return () => {
      tl?.kill();
      tlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ease, items]);

  useLayoutEffect(() => {
    const handleResize = () => {
      if (!tlRef.current) return;
      const wasExpanded = expandedRef.current;
      tlRef.current.kill();
      const next = createTimeline();
      if (!next) return;
      // Rebuilt at the new width, then fast-forwarded if it was already open —
      // otherwise a rotation while the menu is down snaps it shut.
      if (wasExpanded) next.progress(1);
      tlRef.current = next;
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMenu = () => {
    const tl = tlRef.current;
    if (!tl) return;
    if (!isExpanded) {
      expandedRef.current = true;
      setIsExpanded(true);
      tl.play(0);
    } else {
      expandedRef.current = false;
      tl.eventCallback("onReverseComplete", () => setIsExpanded(false));
      tl.reverse();
    }
  };

  const setCardRef = (i: number) => (el: HTMLDivElement | null) => {
    if (el) cardsRef.current[i] = el;
  };

  return (
    <div className={`${styles.container} ${className}`.trim()}>
      <nav
        ref={navRef}
        className={styles.nav}
        data-open={isExpanded}
        style={{ backgroundColor: baseColor }}
      >
        <div className={styles.top}>
          <button
            type="button"
            className={styles.hamburger}
            data-open={isExpanded}
            onClick={toggleMenu}
            aria-label={isExpanded ? "Close menu" : "Open menu"}
            aria-expanded={isExpanded}
            style={{ color: menuColor }}
          >
            <span className={styles.line} />
            <span className={styles.line} />
          </button>

          <Link href="/" className={styles.logo} aria-label="Mandate, home">
            {logo}
          </Link>

          <Link href={ctaHref} className={styles.cta}>
            {ctaLabel}
          </Link>
        </div>

        <div className={styles.content} ref={contentRef} aria-hidden={!isExpanded}>
          {items.slice(0, 3).map((item, idx) => (
            <div
              key={item.label}
              className={styles.card}
              ref={setCardRef(idx)}
              style={{ backgroundColor: item.bgColor, color: item.textColor }}
            >
              <div className={styles.cardLabel}>{item.label}</div>
              <div className={styles.cardLinks}>
                {item.links.map((lnk) => {
                  const external = lnk.href.startsWith("http");
                  const content = (
                    <>
                      <ArrowIcon />
                      {lnk.label}
                    </>
                  );
                  // Anything off-site or on-page stays a plain anchor; the
                  // router has nothing useful to do with either.
                  return external || lnk.href.startsWith("#") ? (
                    <a
                      key={lnk.label}
                      className={styles.cardLink}
                      href={lnk.href}
                      aria-label={lnk.ariaLabel}
                      tabIndex={isExpanded ? 0 : -1}
                      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    >
                      {content}
                    </a>
                  ) : (
                    <Link
                      key={lnk.label}
                      className={styles.cardLink}
                      href={lnk.href}
                      aria-label={lnk.ariaLabel}
                      tabIndex={isExpanded ? 0 : -1}
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}
