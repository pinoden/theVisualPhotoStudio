"""
Booking wizard – single-page multi-step form.
The actual booking creation is handled here after JS collects all data.
"""
from datetime import date as date_type, time as time_type, datetime
from flask import Blueprint, render_template, request, jsonify, current_app
from app import db
from app.models import Studio, Booking
from app.utils import calculate_price, charge_square, get_available_slots
from app.email import send_booking_confirmation, send_booking_notification_to_owner

booking_bp = Blueprint('booking', __name__)


@booking_bp.route('/book')
def book():
    studios = Studio.query.filter_by(is_active=True).all()
    square_app_id = current_app.config.get('SQUARE_APPLICATION_ID', '')
    square_env = current_app.config.get('SQUARE_ENVIRONMENT', 'sandbox')
    square_location_id = current_app.config.get('SQUARE_LOCATION_ID', '')
    return render_template(
        'book.html',
        studios=studios,
        square_app_id=square_app_id,
        square_env=square_env,
        square_location_id=square_location_id,
    )


@booking_bp.route('/book/create', methods=['POST'])
def create_booking():
    """
    Called by the booking wizard JS when the user confirms and pays.
    Expected JSON body:
      studio_ids, service_type, date, start_time, duration,
      customer_name, customer_email, customer_phone, notes,
      payment_type (deposit | full | none),
      square_token (nonce from Square Web Payments SDK)
    """
    data = request.get_json(force=True)

    # ── Validate required fields ──────────────────────────────────────────
    required = ['studio_ids', 'date', 'start_time', 'duration',
                'customer_name', 'customer_email']
    for field in required:
        if not data.get(field):
            return jsonify({'error': f'Missing field: {field}'}), 400

    studio_ids = data['studio_ids']
    studios = Studio.query.filter(Studio.id.in_(studio_ids), Studio.is_active == True).all()
    if not studios:
        return jsonify({'error': 'Invalid studios selected'}), 400

    # ── Parse date / time ─────────────────────────────────────────────────
    try:
        booking_date = date_type.fromisoformat(data['date'])
        duration = float(data['duration'])
        start_h, start_m = map(int, data['start_time'].split(':'))
        start_time = time_type(start_h, start_m)
        total_minutes = int(duration * 60)
        end_total = start_h * 60 + start_m + total_minutes
        end_time = time_type(end_total // 60, end_total % 60)
    except (ValueError, KeyError) as e:
        return jsonify({'error': f'Invalid date/time: {e}'}), 400

    # ── Check availability (double-check server-side) ─────────────────────
    available_slots = get_available_slots(studios, booking_date, duration)
    if data['start_time'] not in available_slots:
        return jsonify({'error': 'That time slot is no longer available. Please choose another.'}), 409

    # ── Pricing ───────────────────────────────────────────────────────────
    service_type = data.get('service_type', 'rental')
    pricing = calculate_price(studios, duration, service_type)
    payment_type = data.get('payment_type', 'deposit')  # deposit | full | none

    if payment_type == 'full':
        charge_amount = pricing['total']
    elif payment_type == 'deposit':
        charge_amount = pricing['deposit_amount']
    else:
        charge_amount = 0.0

    # ── Charge Square ─────────────────────────────────────────────────────
    payment_id = None
    payment_status = 'pending'

    if charge_amount > 0:
        square_token = data.get('square_token')
        if not square_token:
            return jsonify({'error': 'Payment token missing'}), 400

        note = f"Booking {data['customer_name']} – " + ', '.join(s.name for s in studios)
        success, result = charge_square(square_token, charge_amount, note)
        if not success:
            return jsonify({'error': f'Payment failed: {result}'}), 402
        payment_id = result
        payment_status = 'paid' if payment_type == 'full' else 'deposit_paid'

    # ── Create booking record ─────────────────────────────────────────────
    booking = Booking(
        customer_name=data['customer_name'],
        customer_email=data['customer_email'],
        customer_phone=data.get('customer_phone', ''),
        notes=data.get('notes', ''),
        date=booking_date,
        start_time=start_time,
        end_time=end_time,
        duration_hours=duration,
        service_type=service_type,
        subtotal=pricing['subtotal'],
        discount_pct=pricing['discount_pct'],
        discount_amount=pricing['discount_amount'],
        total=pricing['total'],
        deposit_amount=pricing['deposit_amount'],
        amount_paid=charge_amount,
        payment_status=payment_status,
        payment_id=payment_id,
        status='confirmed',
    )
    booking.studios = studios
    db.session.add(booking)
    db.session.commit()

    # ── Send emails ───────────────────────────────────────────────────────
    try:
        send_booking_confirmation(booking)
        send_booking_notification_to_owner(booking)
    except Exception as e:
        current_app.logger.error(f'Email error for booking {booking.booking_ref}: {e}')

    return jsonify({
        'success': True,
        'booking_ref': booking.booking_ref,
        'booking_id': booking.id,
    })


@booking_bp.route('/booking/confirmation/<booking_ref>')
def booking_confirmation(booking_ref):
    booking = Booking.query.filter_by(booking_ref=booking_ref).first_or_404()
    return render_template('booking_confirm.html', booking=booking)
