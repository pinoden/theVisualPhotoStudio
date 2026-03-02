"""
Admin dashboard – all routes require login.
"""
from datetime import date as date_type, time as time_type, datetime, timedelta
from flask import (Blueprint, render_template, redirect, url_for,
                   flash, request, jsonify)
from flask_login import login_user, logout_user, login_required, current_user
from app import db
from app.models import AdminUser, Booking, Studio, BlockedSlot
from app.email import send_cancellation_email

admin_bp = Blueprint('admin', __name__)


# ─── Auth ─────────────────────────────────────────────────────────────────────

@admin_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('admin.dashboard'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = AdminUser.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user, remember=True)
            return redirect(request.args.get('next') or url_for('admin.dashboard'))
        flash('Invalid username or password.', 'error')
    return render_template('admin/login.html')


@admin_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('admin.login'))


# ─── Dashboard ────────────────────────────────────────────────────────────────

@admin_bp.route('/')
@admin_bp.route('/dashboard')
@login_required
def dashboard():
    today = date_type.today()
    upcoming = (
        Booking.query
        .filter(Booking.date >= today, Booking.status == 'confirmed')
        .order_by(Booking.date, Booking.start_time)
        .limit(10)
        .all()
    )
    # Simple stats
    total_bookings = Booking.query.filter(Booking.status != 'cancelled').count()
    this_month = (
        Booking.query
        .filter(
            Booking.status != 'cancelled',
            db.extract('month', Booking.date) == today.month,
            db.extract('year', Booking.date) == today.year,
        )
        .all()
    )
    monthly_revenue = sum(b.amount_paid for b in this_month)
    studios = Studio.query.all()
    return render_template(
        'admin/dashboard.html',
        upcoming=upcoming,
        total_bookings=total_bookings,
        monthly_revenue=monthly_revenue,
        studios=studios,
        today=today,
    )


# ─── Bookings list ────────────────────────────────────────────────────────────

@admin_bp.route('/bookings')
@login_required
def bookings():
    filter_status = request.args.get('status', 'all')
    filter_date = request.args.get('date', '')
    query = Booking.query

    if filter_status != 'all':
        query = query.filter(Booking.status == filter_status)
    if filter_date:
        try:
            d = date_type.fromisoformat(filter_date)
            query = query.filter(Booking.date == d)
        except ValueError:
            pass

    bookings = query.order_by(Booking.date.desc(), Booking.start_time.desc()).all()
    return render_template(
        'admin/bookings.html',
        bookings=bookings,
        filter_status=filter_status,
        filter_date=filter_date,
    )


@admin_bp.route('/bookings/<int:booking_id>/cancel', methods=['POST'])
@login_required
def cancel_booking(booking_id):
    booking = Booking.query.get_or_404(booking_id)
    if booking.status == 'cancelled':
        flash('Booking is already cancelled.', 'warning')
    else:
        booking.status = 'cancelled'
        db.session.commit()
        try:
            send_cancellation_email(booking)
        except Exception:
            pass
        flash(f'Booking {booking.booking_ref} cancelled.', 'success')
    return redirect(url_for('admin.bookings'))


@admin_bp.route('/bookings/<int:booking_id>/complete', methods=['POST'])
@login_required
def complete_booking(booking_id):
    booking = Booking.query.get_or_404(booking_id)
    booking.status = 'completed'
    db.session.commit()
    flash(f'Booking {booking.booking_ref} marked as completed.', 'success')
    return redirect(url_for('admin.bookings'))


# ─── Availability / blocked slots ────────────────────────────────────────────

@admin_bp.route('/availability')
@login_required
def availability():
    studios = Studio.query.all()
    today = date_type.today()
    # Show next 60 days of blocks
    blocks = (
        BlockedSlot.query
        .filter(BlockedSlot.date >= today)
        .order_by(BlockedSlot.date)
        .all()
    )
    return render_template('admin/availability.html', studios=studios, blocks=blocks, today=today)


@admin_bp.route('/availability/block', methods=['POST'])
@login_required
def block_slot():
    studio_id = request.form.get('studio_id') or None
    if studio_id:
        studio_id = int(studio_id)
    date_str = request.form.get('date', '')
    start_str = request.form.get('start_time', '')
    end_str = request.form.get('end_time', '')
    note = request.form.get('note', '')

    try:
        block_date = date_type.fromisoformat(date_str)
    except ValueError:
        flash('Invalid date.', 'error')
        return redirect(url_for('admin.availability'))

    start_time = None
    end_time = None
    if start_str and end_str:
        try:
            sh, sm = map(int, start_str.split(':'))
            eh, em = map(int, end_str.split(':'))
            start_time = time_type(sh, sm)
            end_time = time_type(eh, em)
        except (ValueError, TypeError):
            pass

    block = BlockedSlot(
        studio_id=studio_id,
        date=block_date,
        start_time=start_time,
        end_time=end_time,
        note=note,
    )
    db.session.add(block)
    db.session.commit()
    flash('Date/time blocked successfully.', 'success')
    return redirect(url_for('admin.availability'))


@admin_bp.route('/availability/unblock/<int:block_id>', methods=['POST'])
@login_required
def unblock_slot(block_id):
    block = BlockedSlot.query.get_or_404(block_id)
    db.session.delete(block)
    db.session.commit()
    flash('Block removed.', 'success')
    return redirect(url_for('admin.availability'))


# ─── Calendar API ─────────────────────────────────────────────────────────────

@admin_bp.route('/calendar-data')
@login_required
def calendar_data():
    """Return booking events for FullCalendar."""
    start_str = request.args.get('start', '')
    end_str = request.args.get('end', '')
    events = []

    query = Booking.query.filter(Booking.status != 'cancelled')
    if start_str:
        try:
            start_d = date_type.fromisoformat(start_str[:10])
            query = query.filter(Booking.date >= start_d)
        except ValueError:
            pass
    if end_str:
        try:
            end_d = date_type.fromisoformat(end_str[:10])
            query = query.filter(Booking.date <= end_d)
        except ValueError:
            pass

    for b in query.all():
        color_map = {'rental': '#C8A882', 'photography': '#8B9E8A', 'content': '#A8BDCA'}
        events.append({
            'id': b.id,
            'title': f'{b.customer_name} – {b.studio_names}',
            'start': f'{b.date.isoformat()}T{b.start_time.strftime("%H:%M:%S")}',
            'end': f'{b.date.isoformat()}T{b.end_time.strftime("%H:%M:%S")}',
            'color': color_map.get(b.service_type, '#C8A882'),
            'url': url_for('admin.bookings') + f'?ref={b.booking_ref}',
        })

    return jsonify(events)


# ─── Studio management ────────────────────────────────────────────────────────

@admin_bp.route('/studios')
@login_required
def manage_studios():
    studios = Studio.query.all()
    return render_template('admin/studios.html', studios=studios)


@admin_bp.route('/studios/<int:studio_id>/rate', methods=['POST'])
@login_required
def update_rate(studio_id):
    studio = Studio.query.get_or_404(studio_id)
    try:
        studio.hourly_rate = float(request.form['hourly_rate'])
        db.session.commit()
        flash(f'{studio.name} rate updated.', 'success')
    except (ValueError, KeyError):
        flash('Invalid rate value.', 'error')
    return redirect(url_for('admin.manage_studios'))


# ─── Change admin password ────────────────────────────────────────────────────

@admin_bp.route('/settings', methods=['GET', 'POST'])
@login_required
def settings():
    if request.method == 'POST':
        current_pw = request.form.get('current_password', '')
        new_pw = request.form.get('new_password', '')
        confirm_pw = request.form.get('confirm_password', '')
        if not current_user.check_password(current_pw):
            flash('Current password is incorrect.', 'error')
        elif new_pw != confirm_pw:
            flash('New passwords do not match.', 'error')
        elif len(new_pw) < 8:
            flash('Password must be at least 8 characters.', 'error')
        else:
            current_user.set_password(new_pw)
            db.session.commit()
            flash('Password updated successfully.', 'success')
    return render_template('admin/settings.html')
