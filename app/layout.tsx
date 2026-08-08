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
    title: "DOTDNA — Local DNA Workspace",
    description: "Open, map, edit, annotate, analyze, and export SnapGene, GenBank, FASTA, and pasted DNA entirely in your browser.",
    openGraph: {
      title: "DOTDNA — Local DNA Workspace",
      description: "Map, edit, annotate, design primers, simulate PCR and digests, translate, and export—without uploading your DNA.",
      images: [{ url: ogImage, width: 1730, height: 909, alt: "DOTDNA local DNA workspace" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "DOTDNA — Local DNA Workspace",
      description: "A private browser workspace for everyday DNA sequence work.",
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
