import type { Metadata, Viewport } from "next";
import { Syne, Space_Mono } from "next/font/google";
import "./globals.css";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Robin — Your On-Shift Sidekick",
  description: "Your on-shift sidekick for emergency medicine",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Robin",
    statusBarStyle: "default",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#E04B20",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${syne.variable} ${spaceMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="apple-touch-icon" href="/api/pwa-icon?size=180" />
      </head>
      <body className={`${syne.variable} ${spaceMono.variable} min-h-full flex flex-col`}>
        {children}
      </body>
    </html>
  );
}
