import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next's own dev-only indicator, bottom-left. It sits on every page whether
  // or not anything is rendering, and on a projector beside a live dashboard it
  // reads as a hung app rather than as a framework badge. It never ships to
  // production; this only stops it during a demo.
  devIndicators: false,

  async rewrites() {
    return [
      // Web Bot Auth's directory lives at a fixed well-known path, which is
      // per-origin and cannot carry a merchant slug. With more than one
      // merchant on an origin there is no single correct answer, so the
      // well-known path serves the merchant named by MANDATE_PUBLIC_MERCHANT
      // (the deployment's public storefront) and every merchant also has an
      // explicit /api/m/<slug>/wba-directory that is unambiguous.
      {
        source: "/.well-known/http-message-signatures-directory",
        destination: `/api/m/${process.env.MANDATE_PUBLIC_MERCHANT ?? "demo"}/wba-directory`,
      },
    ];
  },
};

export default nextConfig;
