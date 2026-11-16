import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { multiStudioOffer, petPolicy } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { count, hoursWithDays as span, listInWords as list } from "@/lib/words";
import { getCatalog } from "@/server/cached";
import { siteFrame } from "@/server/site";

export const metadata: Metadata = { title: "Guest Information" };

interface Question {
  q: string;
  a: ReactNode;
}

/**
 * Answers to what guests ask before a visit, following the studio's guest
 * information. Every number that is a setting or a price (refund window and
 * fee, notice, how often and how late a booking can move, discounts, the
 * loyalty reward, the pet fee, included guests) is read from the catalog, so
 * this page follows what the owner changes in the admin. Whether larger
 * groups and pets can be booked follows the add-ons on offer, by what the
 * owner says each one is for (its kind), never by its name. The house rules
 * are written by hand here and on the policies page: change both together.
 */
export default async function FaqPage() {
  const [catalog, { frame }] = await Promise.all([getCatalog(), siteFrame()]);
  const { business } = frame;
  const s = catalog.settings;
  const offer = multiStudioOffer(catalog);

  // Pets are welcome wherever a pet add-on can be booked: in one studio, in several, or in all of them.
  const { studios: petStudios, petFreeStudios, fees: petFees, oneFee: onePetFee } = petPolicy(catalog);
  const extraPeople = catalog.addons.some((addon) => addon.kind === "people");

  const visit: Question[] = [
    {
      q: "Where are you located?",
      a: (
        <p>
          We are at {business.addressLine1}, {business.addressLine2}. The studios are on the 3rd floor.{" "}
          <a href={business.mapsUrl} target="_blank" rel="noreferrer">
            Open in Maps
          </a>
        </p>
      ),
    },
    ...(catalog.accessInfoSent
      ? [
          {
            q: "How do I get into the building?",
            a: (
              <p>
                Your confirmation email tells you how to get in. Please read it before you set off. The same
                instructions are on your booking page.
              </p>
            ),
          },
        ]
      : []),
    { q: "Is there parking?", a: <p>Yes. There is free parking around the building.</p> },
    {
      q: "Will someone be at the studio?",
      a: (
        <p>
          A studio attendant is always available to help during your appointment. If you have any questions, please
          ask them.
        </p>
      ),
    },
    { q: "Is there a restroom?", a: <p>A public restroom is on the 3rd floor, by the elevator.</p> },
    {
      q: "What if I leave something behind?",
      a: (
        <p>
          Please contact us as soon as possible. We check each studio at the end of the day. We can keep lost items
          for one month before discarding them, so please double-check your belongings before you leave.
        </p>
      ),
    },
    ...(petStudios.length > 0
      ? [
          {
            q: "Can I bring my pet?",
            a: (
              <>
                <p>
                  {petFreeStudios.length === 0
                    ? "Pets are welcome in every studio. The common areas are pet-free."
                    : `Pets are welcome in ${list(petStudios)} only. ${list([...petFreeStudios, "all common areas"])} are pet-free.`}
                </p>
                <ul>
                  <li>A maximum of 2 pets per reservation, up to 70 lbs each.</li>
                  <li>
                    {onePetFee
                      ? `A ${formatCents(petFees[0].cents)} pet fee applies per reservation and must be added when you book.`
                      : `A pet fee applies per reservation and must be added when you book: ${list(petFees.map((fee) => `${formatCents(fee.cents)} for ${fee.studio}`))}.`}
                  </li>
                  <li>
                    Pets stay on a leash or in a carrier when they are not being photographed, and may not be left
                    unattended.
                  </li>
                  <li>
                    Bring pets directly into the studio you booked. They are not permitted in the reception area
                    {petFreeStudios.length > 0 ? ", the shared prep areas or the other studios." : " or the shared prep areas."}
                  </li>
                  <li>
                    Owners clean up after their pets and are responsible for any damage or extra cleaning. The pet
                    fee is not a damage deposit.
                  </li>
                  <li>A pet that behaves aggressively or unsafely may be asked to leave.</li>
                </ul>
              </>
            ),
          },
        ]
      : []),
    {
      q: "Are there paper backdrops?",
      a: (
        <p>
          Yes, in Studio Dayglow and Studio Blanche. In Studio Blanche the backdrops are attached to the wall and
          cannot be changed. In Studio Dayglow they are on a floor stand and can be switched during your appointment
          at no charge.
        </p>
      ),
    },
    {
      q: "Do you provide any equipment?",
      a: (
        <p>
          Yes. We have three continuous lights (Amaran 150, Godox and Neewer), free of charge on a first-come,
          first-served basis. Please learn how to operate the equipment before you come: we cannot be responsible
          for the result of your shoot if you are unfamiliar with it.
        </p>
      ),
    },
  ];

  const booking: Question[] = [
    {
      q: "How do I book?",
      a: (
        <p>
          Click <Link href="/book">Book Now</Link> and choose your studio, date and time, or start from the date to
          see which studios are free. After you fill in your details and pay, you receive a confirmation email.
          Bookings open {count(s.maxAdvanceDays, "day")} ahead
          {s.minLeadHours > 0
            ? ` and close ${span(s.minLeadHours)} before the start time.`
            : " and can be made right up to the start time."}
        </p>
      ),
    },
    {
      q: "Can I book more than one studio?",
      a: (
        <p>
          Yes. Select any combination of studios in one booking; each is reserved for you for the whole session.
          {offer && ` You get ${offer}.`}
        </p>
      ),
    },
    {
      q: "What should I check in my confirmation email?",
      a: (
        <p>
          The date and the time. The studio is open by appointment only, so if you book the wrong date or time you
          may arrive when nobody is there to help you. The email also has a private link to your booking, where you
          can cancel or move it.
        </p>
      ),
    },
    {
      q: "Can I cancel, and do I get a refund?",
      a: (
        <ul>
          <li>
            {s.refundWindowHours > 0
              ? `Cancel ${span(s.refundWindowHours)} or more before your start time`
              : "Cancel at any time before your start time"}{" "}
            and your payment is refunded to your card automatically
            {s.refundFeePercent > 0 && `, less the ${s.refundFeePercent}% payment processing fee`}.
          </li>
          {s.refundWindowHours > 0 && (
            <li>
              Closer to the start than that, a cancellation is not refunded
              {s.maxReschedules > 0 && ". You can move the booking instead: see the next question"}.
            </li>
          )}
          <li>A booking that has been moved can no longer be refunded.</li>
          <li>Cancel from the link in your confirmation email, or from My Bookings.</li>
        </ul>
      ),
    },
    ...(s.maxReschedules > 0
      ? [
          {
            q: "Can I move my booking to another time?",
            a: (
              <p>
                Yes, {s.maxReschedules === 1 ? "once" : `up to ${s.maxReschedules} times`},{" "}
                {s.rescheduleCutoffHours > 0 ? `until ${span(s.rescheduleCutoffHours)} before it starts` : "until it starts"}.
                Press Reschedule on your booking page or in My Bookings. We release your time and email you a code
                worth what you paid, plus anything a discount code took off that booking, so the same booking at a
                new time costs nothing more. Book the new time and enter the code at checkout: if the new booking
                costs more you pay the difference, and if it costs less the rest stays on the code. The code is
                valid for {count(s.creditValidDays, "day")}.
              </p>
            ),
          },
        ]
      : []),
    {
      q: "What if I have an emergency and cannot make it?",
      a: (
        <p>
          <Link href="/contact">Contact us</Link> as soon as possible and we will reschedule your appointment free
          of charge.
        </p>
      ),
    },
    ...(s.loyaltyEnabled
      ? [
          {
            q: "Do returning guests get anything?",
            a: (
              <ul>
                <li>
                  Yes. When you have visited us {count(s.loyaltyVisits, "time")}, on separate days, we email you a
                  code for one free hour in any studio. Visits are counted by the email address you book with.
                </li>
                <li>
                  The price of one hour comes off your booking: a one-hour booking is free, and a longer one costs
                  the rest.
                </li>
                <li>
                  The free hour is for one studio. It cannot be used when you book several studios together, and it
                  does not pay for add-ons.
                </li>
                <li>
                  It is valid for {count(s.loyaltyValidDays, "day")}. After that the count starts again: every{" "}
                  {count(s.loyaltyVisits, "visit")} earn another hour. A visit made with a free hour does not count,
                  and neither does a photography session with our photographer.
                </li>
              </ul>
            ),
          },
        ]
      : []),
  ];

  const session: Question[] = [
    {
      q: "When should I arrive?",
      a: <p>Your booking begins at your scheduled start time. Please arrive no more than five minutes early.</p>,
    },
    {
      q: "Is setup time included?",
      a: (
        <p>
          Setup and cleanup are part of your booking time. Please allow enough time if you will be moving furniture
          or bringing props.
        </p>
      ),
    },
    {
      q: "How many people can I bring?",
      a: (
        <p>
          The price of each studio includes a number of guests:{" "}
          {list(catalog.studios.map((studio) => `${studio.name} up to ${studio.includedGuests}`))}.
          {extraPeople && (
            <>
              {" "}
              If more are coming, add extra people when you book; the prices are on the{" "}
              <Link href="/rates">Rates</Link> page.
            </>
          )}
        </p>
      ),
    },
    {
      q: "What are the rules during a session?",
      a: (
        <ul>
          <li>Food and drinks are not permitted on furniture.</li>
          <li>
            Furniture may be moved unless noted otherwise. Lift it, never drag it. Mirrors and glass items may not
            be moved.
          </li>
          <li>Return all furniture and props to where you found them before you leave.</li>
          <li>Children are welcome and must be supervised by an adult at all times.</li>
        </ul>
      ),
    },
    {
      q: "How should I look after the studio?",
      a: (
        <ul>
          <li>Handle all furniture, props and equipment with care.</li>
          <li>Keep shoes off furniture and upholstered pieces.</li>
          <li>
            Confetti, glitter, smoke or fog machines, popping champagne and messy materials such as sand, powder or
            paint are not permitted without prior approval.
          </li>
          <li>Avoid body oils, self-tanners and other products that may transfer onto furniture or props.</li>
          <li>Report any accidental damage or spills right away.</li>
          <li>
            Studio Blanche requires shoe covers or socks, and the cyclorama curve should never be stepped on.
          </li>
        </ul>
      ),
    },
  ];

  const minis: Question[] = [
    {
      q: "How does the guest limit work during mini sessions?",
      a: (
        <p>
          It applies to the number of people inside the studio at one time, not to the total number of clients you
          photograph during your reservation. You may photograph several families or clients through the day as
          long as the limit for your studio is not exceeded at any one time.
        </p>
      ),
    },
    {
      q: "Where can my clients wait?",
      a: (
        <p>
          Please schedule mini sessions so that clients arrive close to their own session time. The common and
          preparation areas are shared and should not be used as a waiting room for several families or groups.
          Only clients taking part in or preparing for their session should be inside the studio.
        </p>
      ),
    },
    {
      q: "Can I bring my own setup and decor?",
      a: (
        <p>
          Yes, as long as everything follows the studio rules. Setup and breakdown are part of your reservation
          time. Furniture and props must go back to their original places, and your own decor and equipment must be
          completely removed before your booking ends.
        </p>
      ),
    },
  ];

  const sections = [
    { title: "Before You Visit", questions: visit },
    { title: "Booking, Changes and Refunds", questions: booking },
    { title: "Your Session", questions: session },
    { title: "Mini Sessions", questions: minis },
  ];

  return (
    <div className="site-page">
      <div className="page-banner">
        <p className="section-eyebrow">Common Questions</p>
        <h1>Guest Information</h1>
        <p>Everything you need to know before your visit, from booking and parking to studio rules and equipment.</p>
      </div>

      <section className="section section-cream">
        <div className="container-sm">
          {sections.map((section) => (
            <div key={section.title} className="faq-section">
              <h2>{section.title}</h2>
              {section.questions.map((question) => (
                <details className="faq-item" key={question.q}>
                  <summary className="faq-question">
                    {question.q}
                    <span className="faq-icon" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <div className="faq-answer">{question.a}</div>
                </details>
              ))}
            </div>
          ))}

          <div className="faq-more">
            <h3>Still Have Questions?</h3>
            <p>We are happy to help. The full rental terms are on the Policies page.</p>
            <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/contact" className="btn btn-outline">
                Contact Us
              </Link>
              <Link href="/policies" className="btn btn-outline">
                Policies
              </Link>
              <Link href="/book" className="btn btn-primary">
                Book Now
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
