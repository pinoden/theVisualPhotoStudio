import type { Metadata } from "next";
import { Cormorant_Garamond, Lato } from "next/font/google";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["300", "400", "600"],
  style: ["normal", "italic"],
});

const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["300", "400", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "The Visuals Photo Studio | Winter Park, FL",
    template: "%s | The Visuals Photo Studio",
  },
  description:
    "Natural-light photography studios for rent in Winter Park, FL. Studio Blanche, Dayglow and Paris, bookable by the hour.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${cormorant.variable} ${lato.variable}`}>
      <body>
        <SiteNav />
        <main className="page-content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
