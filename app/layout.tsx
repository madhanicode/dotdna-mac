import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#f4f1e8",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const ogImage = `${protocol}://${host}/og.png`;

  return {
    title: "DOTDNA — SnapGene Sequence Reader",
    description: "Open a SnapGene .dna file and instantly copy or export its DNA sequence. Private, fast, and entirely in your browser.",
    openGraph: {
      title: "DOTDNA — SnapGene Sequence Reader",
      description: "Open a SnapGene file. Get the sequence.",
      images: [{ url: ogImage, width: 1730, height: 909, alt: "DOTDNA SnapGene sequence reader" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "DOTDNA — SnapGene Sequence Reader",
      description: "Open a SnapGene file. Get the sequence.",
      images: [ogImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
