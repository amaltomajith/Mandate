import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mandate",
  description: "A merchant-owned control plane for agent-initiated money actions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#0D94FB",
          colorForeground: "#0B1220",
          colorBackground: "#ffffff",
          borderRadius: "0.75rem",
        },
      }}
    >
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
        <body className="min-h-full flex flex-col bg-background text-foreground">{children}</body>
      </html>
    </ClerkProvider>
  );
}
