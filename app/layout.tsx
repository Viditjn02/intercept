import type { Metadata, Viewport } from "next";
import "./globals.css";
import ConvexClientProvider from "@/components/ConvexClientProvider";

export const metadata: Metadata = {
  title: "HOLMES — find the live conversations your buyers are having",
  description:
    "Point HOLMES at a company. A swarm of agents finds the live communities where its buyers are asking the exact question it answers — each a clickable, intent-scored thread with a drafted reply, in under 3 minutes.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
