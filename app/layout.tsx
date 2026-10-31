import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pure Mania",
  description: "Pure Mania file manager backed by private R2 object storage.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
