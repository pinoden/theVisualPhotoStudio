import type { Metadata } from "next";
import { Suspense } from "react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { PreviewBar } from "@/components/PreviewBar";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteNav } from "@/components/SiteNav";
import { designCss } from "@/lib/site/design";
import { isPreview, siteDesign, siteFrame } from "@/server/site";
import { FONT_CLASSES } from "./fonts";
import "./globals.css";

/** The site's title and description, as the owners set them under Admin, Website. A page adds its own name. */
export async function generateMetadata(): Promise<Metadata> {
  const { frame } = await siteFrame();
  return {
    title: { default: frame.search.title, template: `%s | ${frame.business.name}` },
    description: frame.search.description,
  };
}

/**
 * The frame around every page: the published design as CSS variables, the
 * header and the footer. In a preview (src/server/site.ts) the drafts are
 * shown in their place, with a bar that says so.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [design, { frame, announcement }, preview] = await Promise.all([siteDesign(), siteFrame(), isPreview()]);
  return (
    <html lang="en" data-scroll-behavior="smooth" className={FONT_CLASSES}>
      <head>
        {/* Only colours, numbers and fonts of the library reach this text: see parseDesign. */}
        <style id="site-design" dangerouslySetInnerHTML={{ __html: designCss(design) }} />
      </head>
      <body>
        <SiteNav logo={frame.logo} menu={frame.menu} bookButton={frame.bookButton} menuPosition={frame.header.menuPosition} />
        <main className="page-content">
          {announcement && (
            // The bar reads the address of the page, which a page with a changing address only knows when it is asked for.
            <Suspense fallback={null}>
              <AnnouncementBar announcement={frame.announcement} />
            </Suspense>
          )}
          {children}
        </main>
        <SiteFooter frame={frame} />
        {preview && (
          <Suspense fallback={null}>
            <PreviewBar />
          </Suspense>
        )}
      </body>
    </html>
  );
}
