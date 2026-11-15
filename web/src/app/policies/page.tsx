import type { Metadata } from "next";

export const metadata: Metadata = { title: "Studio Policies" };

/**
 * Wording follows the studio's current terms for studio rentals.
 * The refund fee and windows are still open decisions; see CLAUDE.md.
 */
export default function PoliciesPage() {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Good to Know</p>
        <h1>Studio Policies</h1>
        <p>Please read these before booking. You will be asked to agree to them at checkout.</p>
      </div>

      <section className="section section-cream">
        <div className="container-sm policy">
          <h2 style={{ marginTop: 0 }}>Cancellations &amp; Rescheduling</h2>
          <ul>
            <li>
              Cancellations made 7 or more days (168 hours) before the appointment are eligible for a full refund,
              excluding the non-refundable payment processing fee (5%).
            </li>
            <li>
              Cancellations made less than 7 days before the appointment are non-refundable, but may be rescheduled
              at no additional charge.
            </li>
            <li>Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>
          </ul>

          <h2>Rental Time</h2>
          <ul>
            <li>
              Your booking begins and ends at the scheduled time and includes setup, cleanup, loading and unloading.
              The studio must be cleaned and completely vacated by the end of your reservation. Overtime fees may
              apply if additional time is needed.
            </li>
            <li>Please arrive no more than five minutes early. Early drop-offs and late pickups are not permitted.</li>
          </ul>

          <h2>Cleaning &amp; Damage</h2>
          <ul>
            <li>
              Please leave the studio in the condition you found it and return all furniture and props to their
              original locations.
            </li>
            <li>A minimum $70 cleaning fee may be charged if excessive cleaning is required.</li>
            <li>
              Clients are responsible for any damage caused by themselves, their guests, children or pets. If an
              item cannot be repaired, the client is responsible for the full replacement cost plus a 30%
              inconvenience fee.
            </li>
          </ul>

          <h2>Studio Rules</h2>
          <ul>
            <li>Maximum studio capacity applies to all reservations.</li>
            <li>Children must be supervised by an adult at all times.</li>
            <li>Pets are permitted in Studio Dayglow only and must be added to the reservation in advance.</li>
            <li>No smoking or vaping. No confetti or popping champagne. No fog or haze machines.</li>
            <li>No live bands or performances. Full nudity is not permitted.</li>
            <li>Food and drinks are not permitted on furniture.</li>
            <li>Filming or photography in hallways and common areas is not permitted.</li>
            <li>
              Furniture may be moved, but mirrors and glass items may not. Furniture must be lifted, never dragged.
            </li>
          </ul>

          <h2>Studio Blanche: Shoes</h2>
          <p>
            Studio Blanche is an all-white space. Please remove your shoes or wear the provided shoe covers. For
            photos where footwear is part of the look, cover the soles with painter&rsquo;s tape. The cyclorama
            curve should never be stepped on.
          </p>

          <h2>Shared Dressing Area</h2>
          <p>
            Studio Blanche and Studio Paris share a dressing area, so other clients may be present there during
            your booking. Booking both studios together reserves the whole area for you.
          </p>

          <h2>Pets (Studio Dayglow only)</h2>
          <ul>
            <li>A maximum of 2 pets per reservation, up to 70 lbs each.</li>
            <li>A $40 non-refundable pet fee applies per reservation and must be added when booking.</li>
            <li>Pets must be leashed or in a carrier when not being photographed, and supervised at all times.</li>
            <li>
              The pet fee is not a damage deposit. Clients are responsible for any damage or extra cleaning caused
              by their pet.
            </li>
          </ul>

          <h2>Conduct &amp; Liability</h2>
          <p>
            The person who books the studio is responsible for their guests. The Visuals reserves the right to end
            a session without a refund for unsafe, illegal, disruptive or prohibited activity. Use of the studio,
            furniture, props and equipment is at the client&rsquo;s own risk. The Visuals Photo Studio is not
            responsible for injury, loss, theft or damage to clients, guests or their belongings.
          </p>
        </div>
      </section>
    </>
  );
}
