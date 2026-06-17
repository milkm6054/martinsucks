import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HCA Stats Runner",
  description: "Standalone HLL stats scraper for HCA roster data",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto w-full max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
