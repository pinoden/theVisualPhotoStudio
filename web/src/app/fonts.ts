import {
  Bebas_Neue,
  Bodoni_Moda,
  Cinzel,
  Cormorant_Garamond,
  Dancing_Script,
  DM_Sans,
  EB_Garamond,
  Great_Vibes,
  Inter,
  Italiana,
  Jost,
  Josefin_Sans,
  Krona_One,
  Lato,
  Lora,
  Marcellus,
  Michroma,
  Montserrat,
  Open_Sans,
  Oswald,
  Playfair_Display,
  Poppins,
  Raleway,
  Syne,
  Unbounded,
} from "next/font/google";

/**
 * The fonts of the design library (src/lib/site/fonts.ts), declared for the
 * browser. Each call makes the font available under the CSS variable
 * `--font-<id>`; which font a heading or a button actually uses is decided by
 * the design the owners publish (src/lib/site/design.ts).
 *
 * `next/font` downloads the files when the site is built and serves them from
 * the site itself, so no visitor's browser talks to Google. Nothing is
 * preloaded: which fonts are in use is only known when a page is served, and
 * a browser fetches a font the moment a page first uses it.
 *
 * The options have to be written out for every font: the compiler reads them
 * as they stand. A test checks that every font of the library is here.
 */

const cormorantGaramond = Cormorant_Garamond({ variable: "--font-cormorant-garamond", subsets: ["latin"], style: ["normal", "italic"], preload: false });
const playfairDisplay = Playfair_Display({ variable: "--font-playfair-display", subsets: ["latin"], style: ["normal", "italic"], preload: false });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], style: ["normal", "italic"], preload: false });
const ebGaramond = EB_Garamond({ variable: "--font-eb-garamond", subsets: ["latin"], preload: false });
const bodoniModa = Bodoni_Moda({ variable: "--font-bodoni-moda", subsets: ["latin"], preload: false });
const italiana = Italiana({ variable: "--font-italiana", subsets: ["latin"], weight: "400", preload: false });
const marcellus = Marcellus({ variable: "--font-marcellus", subsets: ["latin"], weight: "400", preload: false });
const cinzel = Cinzel({ variable: "--font-cinzel", subsets: ["latin"], preload: false });

const lato = Lato({ variable: "--font-lato", subsets: ["latin"], weight: ["300", "400", "700"], preload: false });
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"], preload: false });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], preload: false });
const raleway = Raleway({ variable: "--font-raleway", subsets: ["latin"], preload: false });
const openSans = Open_Sans({ variable: "--font-open-sans", subsets: ["latin"], preload: false });
const jost = Jost({ variable: "--font-jost", subsets: ["latin"], preload: false });
const josefinSans = Josefin_Sans({ variable: "--font-josefin-sans", subsets: ["latin"], preload: false });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], preload: false });
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["300", "400", "500", "600"], preload: false });

const bebasNeue = Bebas_Neue({ variable: "--font-bebas-neue", subsets: ["latin"], weight: "400", preload: false });
const oswald = Oswald({ variable: "--font-oswald", subsets: ["latin"], preload: false });
const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"], preload: false });
const syne = Syne({ variable: "--font-syne", subsets: ["latin"], preload: false });
const michroma = Michroma({ variable: "--font-michroma", subsets: ["latin"], weight: "400", preload: false });
const kronaOne = Krona_One({ variable: "--font-krona-one", subsets: ["latin"], weight: "400", preload: false });

const greatVibes = Great_Vibes({ variable: "--font-great-vibes", subsets: ["latin"], weight: "400", preload: false });
const dancingScript = Dancing_Script({ variable: "--font-dancing-script", subsets: ["latin"], preload: false });

/** The class names that define every font's variable. They go on `<html>`. */
export const FONT_CLASSES = [
  cormorantGaramond,
  playfairDisplay,
  lora,
  ebGaramond,
  bodoniModa,
  italiana,
  marcellus,
  cinzel,
  lato,
  montserrat,
  inter,
  raleway,
  openSans,
  jost,
  josefinSans,
  dmSans,
  poppins,
  bebasNeue,
  oswald,
  unbounded,
  syne,
  michroma,
  kronaOne,
  greatVibes,
  dancingScript,
]
  .map((font) => font.variable)
  .join(" ");
