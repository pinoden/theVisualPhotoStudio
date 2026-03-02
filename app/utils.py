"""
Utility helpers: availability checking, pricing, Square payments.
"""
from datetime import datetime, time, timedelta, date
from typing import List, Optional, Tuple

from flask import current_app


# ─── Pricing helpers ─────────────────────────────────────────────────────────

def calculate_price(studios, duration_hours: float, service_type: str) -> dict:
    """
    Returns a dict with subtotal, discount_pct, discount_amount, total, deposit_amount.
    """
    config = current_app.config

    if service_type == 'rental':
        subtotal = sum(s.hourly_rate * duration_hours for s in studios)
    elif service_type == 'photography':
        subtotal = 300.0 * duration_hours
    elif service_type == 'content':
        subtotal = 200.0 * duration_hours
    else:
        subtotal = sum(s.hourly_rate * duration_hours for s in studios)

    discount_pct = 0.0
    if len(studios) > 1:
        discount_pct = float(config.get('BUNDLE_DISCOUNT_PCT', 10))

    discount_amount = round(subtotal * discount_pct / 100, 2)
    total = round(subtotal - discount_amount, 2)
    deposit_pct = float(config.get('DEPOSIT_PCT', 30))
    deposit_amount = round(total * deposit_pct / 100, 2)

    return {
        'subtotal': round(subtotal, 2),
        'discount_pct': discount_pct,
        'discount_amount': discount_amount,
        'total': total,
        'deposit_amount': deposit_amount,
        'deposit_pct': deposit_pct,
    }


# ─── Availability helpers ─────────────────────────────────────────────────────

def _time_to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def _minutes_to_time(m: int) -> time:
    return time(m // 60, m % 60)


def get_studio_hours(studio, day_of_week: int):
    """Return (open_time, close_time) for a studio on a given weekday (0=Mon)."""
    for h in studio.hours:
        if h.day_of_week == day_of_week:
            return h.open_time, h.close_time

    # Fallback to config defaults
    cfg = current_app.config
    if day_of_week < 5:  # weekday
        open_str = cfg.get('DEFAULT_WEEKDAY_OPEN', '09:00')
        close_str = cfg.get('DEFAULT_WEEKDAY_CLOSE', '19:00')
    else:
        open_str = cfg.get('DEFAULT_WEEKEND_OPEN', '08:00')
        close_str = cfg.get('DEFAULT_WEEKEND_CLOSE', '20:00')

    oh, om = map(int, open_str.split(':'))
    ch, cm = map(int, close_str.split(':'))
    return time(oh, om), time(ch, cm)


def get_available_slots(studios, booking_date: date, duration_hours: float) -> List[str]:
    """
    Returns list of available start times (HH:MM strings) for the given
    studios, date, and duration. A slot is available only if EVERY selected
    studio is free during that period.
    """
    from app.models import Booking, BlockedSlot

    duration_min = int(duration_hours * 60)
    increment = current_app.config.get('SLOT_INCREMENT_MINUTES', 60)
    day_of_week = booking_date.weekday()  # 0=Monday

    # Determine the earliest open and latest close across all selected studios
    open_minutes = None
    close_minutes = None
    for studio in studios:
        o, c = get_studio_hours(studio, day_of_week)
        o_min = _time_to_minutes(o)
        c_min = _time_to_minutes(c)
        if open_minutes is None or o_min > open_minutes:
            open_minutes = o_min  # use the LATEST open (all must be open)
        if close_minutes is None or c_min < close_minutes:
            close_minutes = c_min  # use the EARLIEST close

    if open_minutes is None or close_minutes is None:
        return []

    studio_ids = [s.id for s in studios]

    # Fetch existing confirmed bookings for these studios on this date
    booked_ranges = []
    bookings = (
        Booking.query
        .filter(
            Booking.date == booking_date,
            Booking.status.in_(['confirmed', 'completed']),
        )
        .all()
    )
    for b in bookings:
        if any(s.id in studio_ids for s in b.studios):
            booked_ranges.append((
                _time_to_minutes(b.start_time),
                _time_to_minutes(b.end_time),
            ))

    # Fetch blocked slots
    blocked_ranges = []
    blocks = BlockedSlot.query.filter(
        BlockedSlot.date == booking_date,
        db.or_(
            BlockedSlot.studio_id.in_(studio_ids),
            BlockedSlot.studio_id.is_(None),
        )
    ).all()
    for bl in blocks:
        if bl.is_full_day:
            blocked_ranges.append((0, 24 * 60))
        else:
            blocked_ranges.append((
                _time_to_minutes(bl.start_time),
                _time_to_minutes(bl.end_time),
            ))

    # Generate candidate slots
    available = []
    cursor = open_minutes
    while cursor + duration_min <= close_minutes:
        slot_end = cursor + duration_min
        overlap = False
        for (bs, be) in booked_ranges + blocked_ranges:
            if cursor < be and slot_end > bs:
                overlap = True
                break
        if not overlap:
            available.append(_minutes_to_time(cursor).strftime('%H:%M'))
        cursor += increment

    return available


# ─── Square helpers ──────────────────────────────────────────────────────────

def charge_square(source_id: str, amount_dollars: float, note: str = '') -> Tuple[bool, str]:
    """
    Charge a card via Square.
    Returns (success: bool, payment_id_or_error: str).
    """
    import uuid
    cfg = current_app.config

    if not cfg.get('SQUARE_ACCESS_TOKEN'):
        # Payment not configured — allow the booking in dev mode
        return True, 'DEV_MODE_NO_CHARGE'

    try:
        from square.client import Client
        client = Client(
            access_token=cfg['SQUARE_ACCESS_TOKEN'],
            environment=cfg.get('SQUARE_ENVIRONMENT', 'sandbox'),
        )
        result = client.payments.create_payment(body={
            'source_id': source_id,
            'idempotency_key': str(uuid.uuid4()),
            'amount_money': {
                'amount': int(round(amount_dollars * 100)),
                'currency': 'USD',
            },
            'location_id': cfg.get('SQUARE_LOCATION_ID', ''),
            'note': note,
        })
        if result.is_success():
            return True, result.body['payment']['id']
        else:
            errors = '; '.join(e['detail'] for e in result.errors)
            return False, errors
    except Exception as exc:
        return False, str(exc)


# Avoid circular import — import db at function-call time
from app import db
