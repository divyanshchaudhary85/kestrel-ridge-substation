import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") || "https";
  const metadataBase = new URL(
    host ? `${protocol}://${host}` : "https://kestrel-ridge-scada.chatgpt.com"
  );

  return {
    metadataBase,
    title: "Kestrel Ridge EMS / SCADA Training",
    description:
      "Interactive 230/34.5 kV substation training with live switching, power flow, protection, events, alarms and FISR.",
    openGraph: {
      type: "website",
      title: "Kestrel Ridge EMS / SCADA Training",
      description:
        "Operate a live substation model, inspect equipment, trace power flow and work through utility training scenarios.",
      images: [{ url: "/og.png", width: 1728, height: 910, alt: "Kestrel Ridge SCADA operator workspace" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Kestrel Ridge EMS / SCADA Training",
      description:
        "A modern interactive substation simulator for switching, alarms, protection and guided scenarios.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
