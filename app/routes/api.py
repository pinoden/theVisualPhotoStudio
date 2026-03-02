"""
JSON API endpoints used by the booking wizard JS.
"""
from datetime import date as date_type
from flask import Blueprint, jsonify, request, current_app
from app.models import Studio, Booking
from app.utils import get_available_slots, calculate_price

api_bp = Blueprint('api', __name__)


@api_bp.route('/studios')
def api_studios():
    studios = Studio.query.filter_by(is_active=True).all()
    return jsonify([s.to_dict() for s in studios])


@api_bp.route('/availability', methods=['POST'])
def api_availability():
    """
    POST body:
      studio_ids: [1, 2]
      date: "2024-06-15"
      duration: 2.0
    Returns:
      { slots: ["09:00", "10:00", ...] }
    """
    data = request.get_json(force=True)
    studio_ids = data.get('studio_ids', [])
    date_str = data.get('date', '')
    duration = float(data.get('duration', 1))

    if not studio_ids or not date_str:
        return jsonify({'error': 'Missing studio_ids or date'}), 400

    try:
        booking_date = date_type.fromisoformat(date_str)
    except ValueError:
        return jsonify({'error': 'Invalid date format'}), 400

    if booking_date < date_type.today():
        return jsonify({'slots': [], 'message': 'Date is in the past'})

    studios = Studio.query.filter(Studio.id.in_(studio_ids), Studio.is_active == True).all()
    if not studios:
        return jsonify({'error': 'Studios not found'}), 404

    slots = get_available_slots(studios, booking_date, duration)
    return jsonify({'slots': slots})


@api_bp.route('/price', methods=['POST'])
def api_price():
    """
    POST body:
      studio_ids: [1, 2]
      duration: 2.0
      service_type: "rental"
    Returns pricing breakdown.
    """
    data = request.get_json(force=True)
    studio_ids = data.get('studio_ids', [])
    duration = float(data.get('duration', 1))
    service_type = data.get('service_type', 'rental')

    studios = Studio.query.filter(Studio.id.in_(studio_ids), Studio.is_active == True).all()
    if not studios:
        return jsonify({'error': 'Studios not found'}), 404

    pricing = calculate_price(studios, duration, service_type)
    return jsonify(pricing)
