import { startProps, type StoredBlock } from "./blocks/fields";
import { BLOCKS, type BlockName } from "./blocks/registry";
import { DEFAULT_FRAME } from "./frame";
import type { PageContent } from "./page";

/**
 * The website's own pages as they were built: the home page, the studios,
 * the rates, photography, the guest information, the policies and contact.
 * They were written in the code until 2026-11-16; since then each is a page
 * of the admin like any other, made of blocks, which the owners change,
 * publish and take back as they like.
 *
 * What is here is only where they start. `ensureBuiltInPages`
 * (src/server/pages.ts) puts each page into a database that has never had
 * it, published, and never again: a page the owners changed, moved or
 * deleted stays as they left it. "Start again from the page as it was built"
 * in a page's history reads it from here.
 *
 * The wording is the wording the code pages had. Every number that is a
 * setting or a price is a live value (`{refund window}`), and what the code
 * pages showed only at times shows only at times here too: a block by its
 * "Show it", a question or a piece of text by the marker it starts with
 * (`{if pets}`; src/lib/site/conditions.ts). So with the settings as they
 * are, the pages read as they did; and when a setting changes, they follow.
 */

export interface BuiltInPage {
  /** Names the page for good, whatever its address and name become. */
  key: string;
  /** Its address without the first slash. "" is the home page. */
  slug: string;
  /** Its name in the admin, and its title in the browser's tab. */
  title: string;
  content: PageContent;
}

type Props = Record<string, unknown>;

/** Blocks of one page, with ids made from the page's key: the same page always gets the same ids. */
function maker(key: string) {
  let n = 0;
  return (type: BlockName, props: Props = {}): StoredBlock => ({
    type,
    props: { ...startProps(BLOCKS[type].fields), id: `${key}-${++n}`, ...props },
  });
}

const META = { title: "", description: "", hidden: false };

/** A paragraph, centred. */
const centred = (html: string) => `<p style="text-align: center">${html}</p>`;

const button = (label: string, link: string, look: "dark" | "accent" | "outline" | "ghost") => ({ label, link, look });

const question = (words: string, answer: string) => ({ question: words, answer });

const MAPS = DEFAULT_FRAME.business.mapsUrl;

function home(): BuiltInPage {
  const b = maker("home");
  return {
    key: "home",
    slug: "",
    title: "Home",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          look: "hero",
          eyebrow: "Winter Park, Florida",
          title: "Where Every Frame",
          accent: "Tells a Story",
          text: "Three unique natural-light studios available by the hour. For photographers, brands, content creators and families.",
          buttons: [button("Book a Studio", "/book", "dark"), button("Explore Studios", "/studios", "ghost")],
        }),
        b("Section", {
          background: "page",
          content: [
            b("Heading", { eyebrow: "Our Spaces", text: "Three Studios, One Vision", line: true }),
            b("Text", { text: centred("Each studio has its own look. Book a single studio or reserve a bundle for the same time."), width: "narrow" }),
            b("StudioCards", { prices: true, viewLabel: "View Studio", bookLabel: "Book Now" }),
          ],
        }),
        b("Section", {
          background: "card",
          content: [
            b("Heading", { eyebrow: "How Booking Works", text: "Two Ways to Book", line: true }),
            b("Cards", {
              cards: [
                { symbol: "✦", title: "Know the studio?", text: "Pick one or more studios and see every time they are free together." },
                { symbol: "✦", title: "Know the time?", text: "Pick a date and time and see which studios are free then." },
                { symbol: "✦", title: "Need more space?", text: "Book Paris with Blanche, Paris with Dayglow or all three studios together." },
              ],
            }),
          ],
        }),
        b("Section", {
          background: "page",
          content: [
            b("Columns", {
              gap: "large",
              middle: "center",
              one: [
                b("Heading", { eyebrow: "Find Us", text: "Located in Winter Park", line: true, align: "start" }),
                b("ContactDetails", { addressLabel: "Address", phoneLabel: "Phone", hoursLabel: "Hours", mapLabel: "", signs: true }),
              ],
              two: [b("LocationCard", { sign: true, buttonLabel: "Open in Maps" })],
            }),
          ],
        }),
        b("Section", {
          background: "card",
          width: "narrow",
          content: [
            b("Heading", { eyebrow: "Ready to Create?", text: "Book Your Session Today", line: true, size: "large" }),
            b("Text", { text: centred("Choose your space, pick a time and get instant confirmation.") }),
            b("Buttons", { buttons: [button("Book a Studio →", "/book", "dark")] }),
          ],
        }),
      ],
    },
  };
}

function studios(): BuiltInPage {
  const b = maker("studios");
  return {
    key: "studios",
    slug: "studios",
    title: "Our Studios",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          eyebrow: "Our Spaces",
          title: "The Studios",
          text: "Three natural-light studios on the third floor at 7457 Aloma Ave. Book one, or several together.",
        }),
        b("StudioDetails", { bookLabel: "Book" }),
      ],
    },
  };
}

function rates(): BuiltInPage {
  const b = maker("rates");
  return {
    key: "rates",
    slug: "rates",
    title: "Rates",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          eyebrow: "Transparent Pricing",
          title: "Studio Rates",
          text: "Studio space rental only; a photographer is not included. Longer bookings cost less per hour.",
        }),
        b("Section", { background: "page", content: [b("RateCards", { bookLabel: "Book Now" })] }),
        b("Section", {
          background: "card",
          width: "narrow",
          when: "several studios offer",
          content: [
            b("Heading", { eyebrow: "Several Studios", text: "Book Studio Bundles", line: true }),
            b("Text", {
              text: centred("Book Paris with Blanche, Paris with Dayglow or all three. Each studio is reserved for the whole session. {several studios offer}."),
            }),
            b("Buttons", { buttons: [button("Choose Studios →", "/book", "dark")] }),
          ],
        }),
        b("Section", {
          background: "page",
          width: "narrow",
          when: "add-ons",
          content: [b("Heading", { eyebrow: "Extras", text: "Add-ons", line: true }), b("AddonPrices")],
        }),
      ],
    },
  };
}

function services(): BuiltInPage {
  const b = maker("services");
  const ownPhotographer = centred('Bringing your own photographer? <a href="/book">Book a studio</a> by the hour.');
  return {
    key: "services",
    slug: "services",
    title: "Professional Photography",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          eyebrow: "Services",
          title: "Professional Photography",
          text: "Want professional pictures taken at our studio, but don’t have a photographer? Book a session with our own photographer.",
        }),
        b("Section", {
          background: "page",
          width: "narrow",
          content: [
            b("Heading", { eyebrow: "Every Package", text: "What’s Included", line: true }),
            b("Text", {
              text: centred(
                "Every package comes with the rental of the studio space, and each session is shot with a professional camera. The packages suit any type of photography: portraits, maternity, family sessions and more.",
              ),
            }),
            b("Table", {
              columns: "3",
              first: "Session",
              second: "Outfits",
              third: "Edited pictures",
              rows: [
                { a: "1 hour", b: "1–2", c: "20", d: "" },
                { a: "2 hours", b: "2–3", c: "30", d: "" },
                { a: "3 hours", b: "3–4", c: "40", d: "" },
                { a: "4 hours", b: "4–5", c: "50", d: "" },
              ],
            }),
            b("Text", { text: "<p>Final images are delivered within 7 to 14 days.</p>", size: "small" }),
          ],
        }),
        b("Section", {
          background: "card",
          width: "narrow",
          when: "photography",
          content: [
            b("Heading", { eyebrow: "How to Book", text: "Choose a Studio, a Session and a Time", line: true }),
            b("Text", {
              text: centred(
                "Pick the studio you would like to be photographed in; its rental is included in the price. Then choose the session length and one of the times our photographer is free, and pay online. Sessions start at {sessions from}. Please book at least {photography notice} ahead.",
              ),
            }),
            b("Buttons", { buttons: [button("See the Studios", "/studios", "outline"), button("Book a Photographer", "/book/photography", "dark")] }),
            b("Text", { text: ownPhotographer, size: "small" }),
          ],
        }),
        b("Section", {
          background: "card",
          width: "narrow",
          when: "not photography",
          content: [
            b("Heading", { eyebrow: "How to Book", text: "Choose a Studio, Then Tell Us When", line: true }),
            b("Text", {
              text: centred(
                "Pick the studio you would like to be photographed in; its rental is included in the price. Then send us a message with the session length and the dates that suit you, and we will reply with the price and the times our photographer is free.",
              ),
            }),
            b("Buttons", { buttons: [button("See the Studios", "/studios", "outline"), button("Ask About a Session", "/contact", "dark")] }),
            b("Text", { text: ownPhotographer, size: "small" }),
          ],
        }),
      ],
    },
  };
}

function faq(): BuiltInPage {
  const b = maker("faq");
  const visit = [
    question(
      "Where are you located?",
      `<p>We are at {address}. The studios are on the 3rd floor. <a href="${MAPS}" target="_blank" rel="noopener noreferrer">Open in Maps</a></p>`,
    ),
    question(
      "{if getting in}How do I get into the building?",
      "<p>Your confirmation email tells you how to get in. Please read it before you set off. The same instructions are on your booking page.</p>",
    ),
    question("Is there parking?", "<p>Yes. There is free parking around the building.</p>"),
    question("Will someone be at the studio?", "<p>A studio attendant is always available to help during your appointment. If you have any questions, please ask them.</p>"),
    question("Is there a restroom?", "<p>A public restroom is on the 3rd floor, by the elevator.</p>"),
    question(
      "What if I leave something behind?",
      "<p>Please contact us as soon as possible. We check each studio at the end of the day. We can keep lost items for one month before discarding them, so please double-check your belongings before you leave.</p>",
    ),
    question(
      "{if pets}Can I bring my pet?",
      "<p>{if pet free studios}Pets are welcome in {pet studios} only. The other studios and all common areas are pet-free.</p>" +
        "<p>{if not pet free studios}Pets are welcome in every studio. The common areas are pet-free.</p>" +
        "<ul>" +
        "<li>A maximum of 2 pets per reservation, up to 70 lbs each.</li>" +
        "<li>A pet fee of {pet fee} applies per reservation and must be added when you book.</li>" +
        "<li>Pets stay on a leash or in a carrier when they are not being photographed, and may not be left unattended.</li>" +
        "<li>Bring pets directly into the studio you booked. They are not permitted in the reception area, the shared prep areas or the other studios.</li>" +
        "<li>Owners clean up after their pets and are responsible for any damage or extra cleaning. The pet fee is not a damage deposit.</li>" +
        "<li>A pet that behaves aggressively or unsafely may be asked to leave.</li>" +
        "</ul>",
    ),
    question(
      "Are there paper backdrops?",
      "<p>Yes, in Studio Dayglow and Studio Blanche. In Studio Blanche the backdrops are attached to the wall and cannot be changed. In Studio Dayglow they are on a floor stand and can be switched during your appointment at no charge.</p>",
    ),
    question(
      "Do you provide any equipment?",
      "<p>Yes. We have three continuous lights (Amaran 150, Godox and Neewer), free of charge on a first-come, first-served basis. Please learn how to operate the equipment before you come: we cannot be responsible for the result of your shoot if you are unfamiliar with it.</p>",
    ),
  ];
  const booking = [
    question(
      "How do I book?",
      '<p>Click <a href="/book">Book Now</a> and choose your studio, date and time, or start from the date to see which studios are free. After you fill in your details and pay, you receive a confirmation email. Bookings open {booking horizon} ahead and close {minimum notice} before the start time.</p>',
    ),
    question(
      "Can I book more than one studio?",
      "<p>Yes. Book Paris with Blanche, Paris with Dayglow or all three. Each studio is reserved for you for the whole session.</p><p>{if several studios offer}You get {several studios offer}.</p>",
    ),
    question(
      "What should I check in my confirmation email?",
      "<p>The date and the time. The studio is open by appointment only, so if you book the wrong date or time you may arrive when nobody is there to help you. The email also has a private link to your booking, where you can cancel or move it.</p>",
    ),
    question(
      "Can I cancel, and do I get a refund?",
      "<ul>" +
        "<li>Cancel {refund window with hours} or more before your start time and your payment is refunded to your card automatically, less the {refund fee} payment processing fee.</li>" +
        "<li>Closer to the start than that, a cancellation is not refunded.</li>" +
        "<li>{if moving}You can move the booking instead: see the next question.</li>" +
        "<li>{if moving}A booking that has been moved can no longer be refunded.</li>" +
        "<li>Cancel from the link in your confirmation email, or from My Bookings.</li>" +
        "</ul>",
    ),
    question(
      "{if moving}Can I move my booking to another time?",
      "<p>Yes, until {reschedule cutoff} before it starts. Press Reschedule on your booking page or in My Bookings. We release your time and email you a code worth what you paid, plus anything a discount code took off that booking, so the same booking at a new time costs nothing more. Book the new time and enter the code at checkout: if the new booking costs more you pay the difference, and if it costs less the rest stays on the code. The code is valid for {reschedule code valid}.</p>" +
        "<p>{if reschedule fee}You can move a booking {reschedules allowed} free of charge. Moving it again costs {reschedule fee} each time, which is taken off the code.</p>" +
        "<p>{if not reschedule fee}A booking can be moved {reschedules allowed}.</p>",
    ),
    question("What if I have an emergency and cannot make it?", '<p><a href="/contact">Contact us</a> as soon as possible and we will reschedule your appointment free of charge.</p>'),
    question(
      "{if free hours}Do returning guests get anything?",
      "<ul>" +
        "<li>Yes. When you have visited us {free hour visits}, on separate days, we email you a code for one free hour in any studio. Visits are counted by the email address you book with.</li>" +
        "<li>The price of one hour comes off your booking: a one-hour booking is free, and a longer one costs the rest.</li>" +
        "<li>The free hour is for one studio. It cannot be used when you book several studios together, and it does not pay for add-ons.</li>" +
        "<li>It is valid for {free hour valid}. The count then starts again, and you earn another hour each time you have visited us {free hour visits} more. A visit made with a free hour does not count, and neither does a photography session with our photographer.</li>" +
        "</ul>",
    ),
  ];
  const session = [
    question("When should I arrive?", "<p>Your booking begins at your scheduled start time. Please arrive no more than five minutes early.</p>"),
    question("Is setup time included?", "<p>Setup and cleanup are part of your booking time. Please allow enough time if you will be moving furniture or bringing props.</p>"),
    question(
      "How many people can I bring?",
      '<p>The price of each studio includes a number of guests: {included guests}.</p><p>{if extra people}If more are coming, add extra people when you book; the prices are on the <a href="/rates">Rates</a> page.</p>',
    ),
    question(
      "What are the rules during a session?",
      "<ul>" +
        "<li>Food and drinks are not allowed inside the studios.</li>" +
        "<li>Furniture may be moved unless noted otherwise. Lift it, never drag it. Mirrors and glass items may not be moved.</li>" +
        "<li>Return all furniture and props to where you found them before you leave.</li>" +
        "<li>Children are welcome and must be supervised by an adult at all times.</li>" +
        "</ul>",
    ),
    question(
      "How should I look after the studio?",
      "<ul>" +
        "<li>Handle all furniture, props and equipment with care.</li>" +
        "<li>Keep shoes off furniture and upholstered pieces.</li>" +
        "<li>Confetti, glitter, smoke or fog machines, popping champagne and messy materials such as sand, powder or paint are not permitted without prior approval.</li>" +
        "<li>Avoid body oils, self-tanners and other products that may transfer onto furniture or props.</li>" +
        "<li>Report any accidental damage or spills right away.</li>" +
        "<li>Studio Blanche requires shoe covers or socks, and the cyclorama curve should never be stepped on.</li>" +
        "</ul>",
    ),
  ];
  const minis = [
    question(
      "How does the guest limit work during mini sessions?",
      "<p>It applies to the number of people inside the studio at one time, not to the total number of clients you photograph during your reservation. You may photograph several families or clients through the day as long as the limit for your studio is not exceeded at any one time.</p>",
    ),
    question(
      "Where can my clients wait?",
      "<p>Please schedule mini sessions so that clients arrive close to their own session time. The common and preparation areas are shared and should not be used as a waiting room for several families or groups. Only clients taking part in or preparing for their session should be inside the studio.</p>",
    ),
    question(
      "Can I bring my own setup and decor?",
      "<p>Yes, as long as everything follows the studio rules. Setup and breakdown are part of your reservation time. Furniture and props must go back to their original places, and your own decor and equipment must be completely removed before your booking ends.</p>",
    ),
  ];
  const part = (heading: string, questions: { question: string; answer: string }[]) => [
    b("Heading", { text: heading, size: "small", align: "start" }),
    b("Questions", { questions }),
  ];
  return {
    key: "faq",
    slug: "faq",
    title: "Guest Information",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          eyebrow: "Common Questions",
          title: "Guest Information",
          text: "Everything you need to know before your visit, from booking and parking to studio rules and equipment.",
        }),
        b("Section", {
          background: "page",
          width: "narrow",
          content: [
            ...part("Before You Visit", visit),
            ...part("Booking, Changes and Refunds", booking),
            ...part("Your Session", session),
            ...part("Mini Sessions", minis),
          ],
        }),
        b("Section", {
          background: "card",
          width: "narrow",
          space: "small",
          content: [
            b("Heading", { text: "Still Have Questions?", level: "h3" }),
            b("Text", { text: centred("We are happy to help. The full rental terms are on the Policies page.") }),
            b("Buttons", { buttons: [button("Contact Us", "/contact", "outline"), button("Policies", "/policies", "outline"), button("Book Now", "/book", "accent")] }),
          ],
        }),
      ],
    },
  };
}

function policies(): BuiltInPage {
  const b = maker("policies");
  const terms =
    "<h2>Cancellations &amp; Rescheduling</h2>" +
    "<ul>" +
    "<li>Cancellations made {refund window with hours} or more before the appointment are eligible for a full refund, excluding the non-refundable payment processing fee ({refund fee}).</li>" +
    "<li>{if moving}Cancellations made less than {refund window} before the appointment are non-refundable, but may be rescheduled at no additional charge until {reschedule cutoff} before the appointment.</li>" +
    "<li>{if not moving}Cancellations made less than {refund window} before the appointment are non-refundable.</li>" +
    "<li>{if reschedule fee}An appointment may be rescheduled {reschedules allowed} at no additional charge. Each additional reschedule costs {reschedule fee}, which is deducted from the reschedule credit.</li>" +
    "<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>" +
    "<li>{if photography}Photography sessions with our in-house photographer follow the same terms: a session cancelled {photography refund window} or more before the appointment is refunded, and one cancelled later is not. Sessions are booked at least {photography notice} ahead.</li>" +
    "</ul>" +
    "<h2>Rental Time</h2>" +
    "<ul>" +
    "<li>Your booking begins and ends at the scheduled time and includes setup, cleanup, loading and unloading. The studio must be cleaned and completely vacated by the end of your reservation. Overtime fees may apply if additional time is needed.</li>" +
    "<li>Please arrive no more than five minutes early. Early drop-offs and late pickups are not permitted.</li>" +
    "</ul>" +
    "<h2>Cleaning &amp; Damage</h2>" +
    "<ul>" +
    "<li>Please leave the studio in the condition you found it and return all furniture and props to their original locations.</li>" +
    "<li>A minimum $70 cleaning fee may be charged if excessive cleaning is required.</li>" +
    "<li>Clients are responsible for any damage caused by themselves, their guests, children or pets. If an item cannot be repaired, the client is responsible for the full replacement cost plus a 30% inconvenience fee.</li>" +
    "</ul>" +
    "<h2>Studio Rules</h2>" +
    "<ul>" +
    "<li>Maximum studio capacity applies to all reservations.</li>" +
    "<li>Children must be supervised by an adult at all times.</li>" +
    "<li>{if pets}{if pet free studios}Pets are permitted in {pet studios} only and must be added to the reservation in advance.</li>" +
    "<li>{if pets}{if not pet free studios}Pets are permitted in every studio and must be added to the reservation in advance.</li>" +
    "<li>{if not pets}Pets are not permitted.</li>" +
    "<li>No smoking or vaping. No confetti or popping champagne. No fog or haze machines.</li>" +
    "<li>No live bands or performances. Full nudity is not permitted.</li>" +
    "<li>Food and drinks are not allowed inside the studios.</li>" +
    "<li>Filming or photography in hallways and common areas is not permitted.</li>" +
    "<li>Furniture may be moved, but mirrors and glass items may not. Furniture must be lifted, never dragged.</li>" +
    "</ul>" +
    "<h2>Studio Blanche: Shoes</h2>" +
    "<p>Studio Blanche is an all-white space. Please remove your shoes or wear the provided shoe covers. For photos where footwear is part of the look, cover the soles with painter’s tape. The cyclorama curve should never be stepped on.</p>" +
    "<h2>Shared Dressing Area</h2>" +
    "<p>Studio Blanche and Studio Paris share a dressing area, so other clients may be present there during your booking. Booking both studios together reserves the whole area for you.</p>";
  const pets =
    "<h2>{if pet free studios}Pets ({pet studios} only)</h2>" +
    "<h2>{if not pet free studios}Pets</h2>" +
    "<ul>" +
    "<li>A maximum of 2 pets per reservation, up to 70 lbs each.</li>" +
    "<li>A pet fee of {pet fee} applies per reservation and must be added when booking. The pet fee is not refunded to your card. If your pet does not come, the fee is returned to you as studio credit for a future booking.</li>" +
    "<li>Pets must be leashed or in a carrier when not being photographed, and supervised at all times.</li>" +
    "<li>The pet fee is not a damage deposit. Clients are responsible for any damage or extra cleaning caused by their pet.</li>" +
    "</ul>";
  const conduct =
    "<h2>Conduct &amp; Liability</h2>" +
    "<p>The person who books the studio is responsible for their guests. {studio name} reserves the right to end a session without a refund for unsafe, illegal, disruptive or prohibited activity. Use of the studio, furniture, props and equipment is at the client’s own risk. {studio name} is not responsible for injury, loss, theft or damage to clients, guests or their belongings.</p>";
  return {
    key: "policies",
    slug: "policies",
    title: "Studio Policies",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          eyebrow: "Good to Know",
          title: "Studio Policies",
          text: "Please read these before booking. You will be asked to agree to them at checkout.",
        }),
        b("Section", {
          background: "page",
          width: "narrow",
          content: [b("Text", { text: terms }), b("Text", { text: pets, when: "pets" }), b("Text", { text: conduct })],
        }),
        b("Section", {
          id: "policies-after-hours",
          width: "narrow",
          space: "small",
          content: [
            b("Text", {
              id: "policies-after-hours-note",
              text: '<p>After-hours bookings are available by request. Use the <a href="/contact">contact form</a> and choose “After-hours booking”.</p>',
            }),
          ],
        }),
      ],
    },
  };
}

function contact(): BuiltInPage {
  const b = maker("contact");
  return {
    key: "contact",
    slug: "contact",
    title: "Contact",
    content: {
      meta: META,
      blocks: [
        b("Banner", {
          eyebrow: "Get in Touch",
          title: "Contact Us",
          text: "Have a question, or want to talk through a booking? Send us a message and we will get back to you.",
        }),
        b("Section", {
          background: "page",
          content: [
            b("Columns", {
              gap: "large",
              one: [
                b("Heading", { text: "Visit Us", align: "start" }),
                b("ContactDetails", { addressLabel: "Address", phoneLabel: "Phone", hoursLabel: "Studio Hours", mapLabel: "Open in Maps", signs: false }),
                b("Buttons", { buttons: [button("Book a Studio", "/book", "dark"), button("Guest Information", "/faq", "outline")], align: "start" }),
              ],
              two: [b("ContactForm")],
            }),
          ],
        }),
      ],
    },
  };
}

/** Every page the website was built with, the home page first. */
export function builtInPages(): BuiltInPage[] {
  return [home(), studios(), rates(), services(), faq(), policies(), contact()];
}

/** One of them by its key, or undefined. */
export function builtInPage(key: string | null | undefined): BuiltInPage | undefined {
  return key ? builtInPages().find((page) => page.key === key) : undefined;
}
