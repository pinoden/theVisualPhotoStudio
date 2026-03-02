"""
Email notification helpers.
All emails are sent asynchronously via Flask-Mail.
"""
from flask import current_app, render_template
from flask_mail import Message
from app import mail


def _send(subject: str, recipients: list, body: str, html: str = None):
    """Send a plain-text (and optional HTML) email."""
    try:
        msg = Message(
            subject=subject,
            sender=current_app.config.get('MAIL_USERNAME', 'noreply@thevisualsphotostudio.com'),
            recipients=recipients,
        )
        msg.body = body
        if html:
            msg.html = html
        mail.send(msg)
    except Exception as exc:
        current_app.logger.error(f'Email send error: {exc}')


def send_booking_confirmation(booking):
    """Send confirmation email to the customer."""
    subject = f'Booking Confirmed – {booking.booking_ref}'
    studios = booking.studio_names
    body = f"""Hi {booking.customer_name},

Your booking at The Visuals Photo Studio is confirmed!

Booking Reference: {booking.booking_ref}
Studio(s): {studios}
Date: {booking.date.strftime('%A, %B %d, %Y')}
Time: {booking.start_time.strftime('%I:%M %p')} – {booking.end_time.strftime('%I:%M %p')}
Duration: {booking.duration_hours} hour(s)
Total: ${booking.total:.2f}
Amount Paid: ${booking.amount_paid:.2f}

Location: 7457 Aloma Ave, Suite 301, Winter Park, FL 32792
Phone: (407) 663-6109

Please arrive 5 minutes before your scheduled time.
Cancellations must be made at least 24 hours in advance.

We look forward to seeing you!
– The Visuals Photo Studio Team
"""
    _send(subject, [booking.customer_email], body)


def send_booking_notification_to_owner(booking):
    """Send a new-booking notification to the studio owner."""
    owner_email = current_app.config.get('STUDIO_EMAIL')
    if not owner_email:
        return

    subject = f'New Booking – {booking.booking_ref}'
    studios = booking.studio_names
    body = f"""New booking received!

Reference: {booking.booking_ref}
Customer: {booking.customer_name}
Email: {booking.customer_email}
Phone: {booking.customer_phone or 'N/A'}

Studio(s): {studios}
Date: {booking.date.strftime('%A, %B %d, %Y')}
Time: {booking.start_time.strftime('%I:%M %p')} – {booking.end_time.strftime('%I:%M %p')}
Duration: {booking.duration_hours} hour(s)
Service: {booking.service_type.title()}

Subtotal: ${booking.subtotal:.2f}
Discount: -${booking.discount_amount:.2f} ({booking.discount_pct:.0f}%)
Total: ${booking.total:.2f}
Paid: ${booking.amount_paid:.2f}
Payment Status: {booking.payment_status.title()}

Notes: {booking.notes or 'None'}
"""
    _send(subject, [owner_email], body)


def send_cancellation_email(booking):
    """Notify customer their booking was cancelled."""
    subject = f'Booking Cancelled – {booking.booking_ref}'
    body = f"""Hi {booking.customer_name},

Your booking {booking.booking_ref} on {booking.date.strftime('%B %d, %Y')} has been cancelled.

If you believe this is an error, please contact us:
Phone: (407) 663-6109
Email: {current_app.config.get('STUDIO_EMAIL', 'studio@thevisualsphotostudio.com')}

– The Visuals Photo Studio Team
"""
    _send(subject, [booking.customer_email], body)
