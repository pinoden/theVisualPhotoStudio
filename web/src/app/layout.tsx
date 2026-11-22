import type { Metadata } from "next";
import { Suspense } from "react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { PreviewBar } from "@/components/PreviewBar";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteNav } from "@/components/SiteNav";
import { designCss } from "@/lib/site/design";
import { isPreview, metadataBase, shareMetadata, siteDesign, siteFrame } from "@/server/site";
import { FONT_CLASSES } from "./fonts";
import "./globals.css";

/** The site's title and description, as the owners set them under Admin, Website. A page adds its own name. */
export async function generateMetadata(): Promise<Metadata> {
  const { frame } = await siteFrame();
  return {
    // The addresses of the sharing picture and of each page are made whole with SITE_URL.
    metadataBase: metadataBase(),
    title: { default: frame.search.title, template: `%s | ${frame.business.name}` },
    description: frame.search.description,
    ...(await shareMetadata({ title: frame.search.title, description: frame.search.description })),
  };
}

/**
 * The frame around every page: the published design as CSS variables, the
 * header and the footer. In a preview (src/server/site.ts) the drafts are
 * shown in their place, with a bar that says so.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [{ design, fonts }, { frame, announcement, logo }, preview] = await Promise.all([siteDesign(), siteFrame(), isPreview()]);
  return (
    <html lang="en" data-scroll-behavior="smooth" className={FONT_CLASSES}>
      <head>
        {/* Only colours, numbers and known fonts reach this text: see parseDesign and fontFaceCss. */}
        <style id="site-design" dangerouslySetInnerHTML={{ __html: designCss(design, fonts) }} />
      </head>
      <body>
        {/* The first stop of the keyboard on every page: past the menu, to the page itself (globals.css shows it only
            while it has the focus). The main element takes the focus, so the next Tab goes on from there in every
            browser. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteNav
          logo={frame.logo}
          logoPicture={logo}
          studioName={frame.business.name}
          menu={frame.menu}
          bookButton={frame.bookButton}
          menuPosition={frame.header.menuPosition}
        />
        <main id="main" className="page-content" tabIndex={-1}>
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
