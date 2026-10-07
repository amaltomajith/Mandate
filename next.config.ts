import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // React Strict Mode mounts, unmounts and remounts every component once in
  // dev. The 3D map's canvas (react-three-fiber) unmounts its WebGL root during
  // that cycle, and React 19 reports "Attempted to synchronously unmount a root
  // while React was already rendering" as an error, over a hundred times a
  // session. It is dev-only noise (production never double-mounts), so it is off.
  reactStrictMode: false,

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
