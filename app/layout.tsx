import type { Metadata, Viewport } from "next";
import "@fontsource-variable/instrument-sans";
import "@fontsource/kalam/400.css";
import "@fontsource/kalam/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scoresheet Scanner",
  description: "Photograph or scan a handwritten chess scoresheet and get the game as board images and PGN.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FBFBF8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
