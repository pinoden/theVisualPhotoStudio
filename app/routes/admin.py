"""
Admin dashboard – all routes require login.
"""
from datetime import date as date_type, time as time_type, datetime, timedelta
from collections import defaultdict

from flask import (Blueprint, render_template, redirect, url_for,
                   flash, request, jsonify, Response)
from flask_login import login_user, logout_user, login_required, current_user
from app import db
from app.models import (AdminUser, Booking, Studio, StudioHours,
                        BlockedSlot, Announcement, DAY_NAMES)
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

    # Unique customers count
    unique_customers = db.session.query(
        db.func.count(db.distinct(Booking.customer_email))
    ).filter(Booking.status != 'cancelled').scalar() or 0

    return render_template(
        'admin/dashboard.html',
        upcoming=upcoming,
        total_bookings=total_bookings,
        monthly_revenue=monthly_revenue,
        studios=studios,
        today=today,
        unique_customers=unique_customers,
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


# ─── Visual Calendar ─────────────────────────────────────────────────────────

@admin_bp.route('/calendar')
@login_required
def calendar_view():
    studios = Studio.query.filter_by(is_active=True).all()
    return render_template('admin/calendar.html', studios=studios)


@admin_bp.route('/calendar-data')
@login_required
def calendar_data():
    """Return booking + blocked-slot events for FullCalendar."""
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
            'title': f'{b.customer_name} \u2013 {b.studio_names}',
            'start': f'{b.date.isoformat()}T{b.start_time.strftime("%H:%M:%S")}',
            'end': f'{b.date.isoformat()}T{b.end_time.strftime("%H:%M:%S")}',
            'color': color_map.get(b.service_type, '#C8A882'),
            'extendedProps': {
                'ref': b.booking_ref,
                'email': b.customer_email,
                'phone': b.customer_phone or '',
                'service': b.service_type,
                'total': f'${b.total:.2f}',
                'status': b.status,
                'payment': b.payment_status.replace('_', ' '),
            },
        })

    # Include blocked slots
    block_query = BlockedSlot.query
    if start_str:
        try:
            start_d = date_type.fromisoformat(start_str[:10])
            block_query = block_query.filter(BlockedSlot.date >= start_d)
        except ValueError:
            pass
    if end_str:
        try:
            end_d = date_type.fromisoformat(end_str[:10])
            block_query = block_query.filter(BlockedSlot.date <= end_d)
        except ValueError:
            pass

    for bl in block_query.all():
        studio_name = bl.studio.name if bl.studio else 'All Studios'
        note_suffix = f' \u2013 {bl.note}' if bl.note else ''
        if bl.is_full_day:
            events.append({
                'id': f'block-{bl.id}',
                'title': f'BLOCKED: {studio_name}{note_suffix}',
                'start': bl.date.isoformat(),
                'allDay': True,
                'color': '#8b2020',
                'display': 'background',
            })
        else:
            events.append({
                'id': f'block-{bl.id}',
                'title': f'BLOCKED: {studio_name}{note_suffix}',
                'start': f'{bl.date.isoformat()}T{bl.start_time.strftime("%H:%M:%S")}',
                'end': f'{bl.date.isoformat()}T{bl.end_time.strftime("%H:%M:%S")}',
                'color': '#8b2020',
            })

    return jsonify(events)


# ─── Availability / blocked slots ────────────────────────────────────────────

@admin_bp.route('/availability')
@login_required
def availability():
    studios = Studio.query.all()
    today = date_type.today()
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


# ─── Studio management (full editing) ────────────────────────────────────────

@admin_bp.route('/studios')
@login_required
def manage_studios():
    studios = Studio.query.all()
    return render_template('admin/studios.html', studios=studios)


@admin_bp.route('/studios/<int:studio_id>/edit', methods=['GET', 'POST'])
@login_required
def edit_studio(studio_id):
    studio = Studio.query.get_or_404(studio_id)
    if request.method == 'POST':
        studio.name = request.form.get('name', studio.name).strip()
        studio.tagline = request.form.get('tagline', '').strip() or None
        studio.description = request.form.get('description', '').strip() or None

        try:
            studio.hourly_rate = float(request.form.get('hourly_rate', studio.hourly_rate))
        except (ValueError, TypeError):
            pass

        # Membership rates
        m5 = request.form.get('member_5h_rate', '').strip()
        studio.member_5h_rate = float(m5) if m5 else None
        m10 = request.form.get('member_10h_rate', '').strip()
        studio.member_10h_rate = float(m10) if m10 else None

        # Active toggle
        studio.is_active = 'is_active' in request.form

        db.session.commit()
        flash(f'{studio.name} updated successfully.', 'success')
        return redirect(url_for('admin.manage_studios'))

    return render_template('admin/edit_studio.html', studio=studio, day_names=DAY_NAMES)


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


# ─── Business Hours management ───────────────────────────────────────────────

@admin_bp.route('/hours')
@login_required
def manage_hours():
    studios = Studio.query.all()
    return render_template('admin/hours.html', studios=studios, day_names=DAY_NAMES)


@admin_bp.route('/hours/<int:studio_id>/update', methods=['POST'])
@login_required
def update_hours(studio_id):
    studio = Studio.query.get_or_404(studio_id)

    # Delete existing hours and recreate
    StudioHours.query.filter_by(studio_id=studio.id).delete()

    for day in range(7):
        open_str = request.form.get(f'open_{day}', '').strip()
        close_str = request.form.get(f'close_{day}', '').strip()
        closed = request.form.get(f'closed_{day}')

        if closed or not open_str or not close_str:
            continue  # skip this day (studio closed)

        try:
            oh, om = map(int, open_str.split(':'))
            ch, cm = map(int, close_str.split(':'))
            hour = StudioHours(
                studio_id=studio.id,
                day_of_week=day,
                open_time=time_type(oh, om),
                close_time=time_type(ch, cm),
            )
            db.session.add(hour)
        except (ValueError, TypeError):
            flash(f'Invalid time for {DAY_NAMES[day]}.', 'error')

    db.session.commit()
    flash(f'Hours for {studio.name} updated.', 'success')
    return redirect(url_for('admin.manage_hours'))


# ─── Customer list with booking history ──────────────────────────────────────

@admin_bp.route('/customers')
@login_required
def customers():
    """Show unique customers aggregated from bookings."""
    all_bookings = (
        Booking.query
        .filter(Booking.status != 'cancelled')
        .order_by(Booking.date.desc())
        .all()
    )

    customer_map = {}
    for b in all_bookings:
        email = b.customer_email.lower()
        if email not in customer_map:
            customer_map[email] = {
                'name': b.customer_name,
                'email': b.customer_email,
                'phone': b.customer_phone or '',
                'bookings': [],
                'total_spent': 0,
                'first_booking': b.date,
                'last_booking': b.date,
            }
        customer_map[email]['bookings'].append(b)
        customer_map[email]['total_spent'] += b.amount_paid
        if b.date < customer_map[email]['first_booking']:
            customer_map[email]['first_booking'] = b.date
        if b.date > customer_map[email]['last_booking']:
            customer_map[email]['last_booking'] = b.date
        # Use most recent name/phone
        if b.date >= customer_map[email]['last_booking']:
            customer_map[email]['name'] = b.customer_name
            if b.customer_phone:
                customer_map[email]['phone'] = b.customer_phone

    # Sort by total spent desc
    customers_list = sorted(customer_map.values(), key=lambda c: c['total_spent'], reverse=True)

    return render_template('admin/customers.html', customers=customers_list)


@admin_bp.route('/customers/<email>')
@login_required
def customer_detail(email):
    """Show booking history for a specific customer."""
    customer_bookings = (
        Booking.query
        .filter(db.func.lower(Booking.customer_email) == email.lower())
        .order_by(Booking.date.desc())
        .all()
    )
    if not customer_bookings:
        flash('Customer not found.', 'error')
        return redirect(url_for('admin.customers'))

    customer = {
        'name': customer_bookings[0].customer_name,
        'email': customer_bookings[0].customer_email,
        'phone': customer_bookings[0].customer_phone or '',
        'total_spent': sum(b.amount_paid for b in customer_bookings if b.status != 'cancelled'),
        'total_bookings': len([b for b in customer_bookings if b.status != 'cancelled']),
    }

    return render_template('admin/customer_detail.html', customer=customer, bookings=customer_bookings)


# ─── Announcements / Banners ────────────────────────────────────────────────

@admin_bp.route('/announcements')
@login_required
def announcements():
    all_announcements = Announcement.query.order_by(Announcement.created_at.desc()).all()
    return render_template('admin/announcements.html', announcements=all_announcements)


@admin_bp.route('/announcements/create', methods=['GET', 'POST'])
@login_required
def create_announcement():
    if request.method == 'POST':
        title = request.form.get('title', '').strip()
        message = request.form.get('message', '').strip()
        link_url = request.form.get('link_url', '').strip() or None
        link_text = request.form.get('link_text', '').strip() or None
        bg_color = request.form.get('bg_color', '#C8A882').strip()
        text_color = request.form.get('text_color', '#ffffff').strip()
        is_active = 'is_active' in request.form
        start_date_str = request.form.get('start_date', '').strip()
        end_date_str = request.form.get('end_date', '').strip()

        start_date = None
        end_date = None
        if start_date_str:
            try:
                start_date = date_type.fromisoformat(start_date_str)
            except ValueError:
                pass
        if end_date_str:
            try:
                end_date = date_type.fromisoformat(end_date_str)
            except ValueError:
                pass

        if not title or not message:
            flash('Title and message are required.', 'error')
            return redirect(url_for('admin.create_announcement'))

        ann = Announcement(
            title=title, message=message, link_url=link_url,
            link_text=link_text, bg_color=bg_color, text_color=text_color,
            is_active=is_active, start_date=start_date, end_date=end_date,
        )
        db.session.add(ann)
        db.session.commit()
        flash('Announcement created.', 'success')
        return redirect(url_for('admin.announcements'))

    return render_template('admin/edit_announcement.html', announcement=None)


@admin_bp.route('/announcements/<int:ann_id>/edit', methods=['GET', 'POST'])
@login_required
def edit_announcement(ann_id):
    ann = Announcement.query.get_or_404(ann_id)
    if request.method == 'POST':
        ann.title = request.form.get('title', ann.title).strip()
        ann.message = request.form.get('message', ann.message).strip()
        ann.link_url = request.form.get('link_url', '').strip() or None
        ann.link_text = request.form.get('link_text', '').strip() or None
        ann.bg_color = request.form.get('bg_color', '#C8A882').strip()
        ann.text_color = request.form.get('text_color', '#ffffff').strip()
        ann.is_active = 'is_active' in request.form

        start_date_str = request.form.get('start_date', '').strip()
        end_date_str = request.form.get('end_date', '').strip()
        ann.start_date = None
        ann.end_date = None
        if start_date_str:
            try:
                ann.start_date = date_type.fromisoformat(start_date_str)
            except ValueError:
                pass
        if end_date_str:
            try:
                ann.end_date = date_type.fromisoformat(end_date_str)
            except ValueError:
                pass

        db.session.commit()
        flash('Announcement updated.', 'success')
        return redirect(url_for('admin.announcements'))

    return render_template('admin/edit_announcement.html', announcement=ann)


@admin_bp.route('/announcements/<int:ann_id>/toggle', methods=['POST'])
@login_required
def toggle_announcement(ann_id):
    ann = Announcement.query.get_or_404(ann_id)
    ann.is_active = not ann.is_active
    db.session.commit()
    status = 'activated' if ann.is_active else 'deactivated'
    flash(f'Announcement "{ann.title}" {status}.', 'success')
    return redirect(url_for('admin.announcements'))


@admin_bp.route('/announcements/<int:ann_id>/delete', methods=['POST'])
@login_required
def delete_announcement(ann_id):
    ann = Announcement.query.get_or_404(ann_id)
    db.session.delete(ann)
    db.session.commit()
    flash('Announcement deleted.', 'success')
    return redirect(url_for('admin.announcements'))


# ─── Revenue Reports ─────────────────────────────────────────────────────────

@admin_bp.route('/reports')
@login_required
def reports():
    year = request.args.get('year', date_type.today().year, type=int)
    month = request.args.get('month', 0, type=int)  # 0 = full year

    studios = Studio.query.all()

    query = Booking.query.filter(
        Booking.status != 'cancelled',
        db.extract('year', Booking.date) == year,
    )
    if month:
        query = query.filter(db.extract('month', Booking.date) == month)

    all_bookings = query.all()

    # Summary stats
    total_revenue = sum(b.amount_paid for b in all_bookings)
    total_bookings_count = len(all_bookings)
    total_hours = sum(b.duration_hours for b in all_bookings)

    # Revenue by studio
    studio_revenue = defaultdict(lambda: {'revenue': 0, 'bookings': 0, 'hours': 0})
    for b in all_bookings:
        for s in b.studios:
            studio_revenue[s.name]['revenue'] += b.amount_paid / max(len(b.studios), 1)
            studio_revenue[s.name]['bookings'] += 1
            studio_revenue[s.name]['hours'] += b.duration_hours

    # Revenue by service type
    service_revenue = defaultdict(lambda: {'revenue': 0, 'bookings': 0})
    for b in all_bookings:
        service_revenue[b.service_type]['revenue'] += b.amount_paid
        service_revenue[b.service_type]['bookings'] += 1

    # Monthly breakdown (for year view)
    monthly_data = []
    if not month:
        for m in range(1, 13):
            m_bookings = [b for b in all_bookings if b.date.month == m]
            monthly_data.append({
                'month': m,
                'month_name': datetime(year, m, 1).strftime('%B'),
                'month_short': datetime(year, m, 1).strftime('%b'),
                'revenue': sum(b.amount_paid for b in m_bookings),
                'bookings': len(m_bookings),
                'hours': sum(b.duration_hours for b in m_bookings),
            })

    # Available years for dropdown
    earliest = db.session.query(db.func.min(Booking.date)).scalar()
    min_year = earliest.year if earliest else year
    years = list(range(min_year, date_type.today().year + 1))

    return render_template(
        'admin/reports.html',
        year=year,
        month=month,
        studios=studios,
        total_revenue=total_revenue,
        total_bookings_count=total_bookings_count,
        total_hours=total_hours,
        studio_revenue=dict(studio_revenue),
        service_revenue=dict(service_revenue),
        monthly_data=monthly_data,
        years=years,
    )


# ─── iCal Feed ───────────────────────────────────────────────────────────────

@admin_bp.route('/ical/<token>.ics')
def ical_feed(token):
    """
    Public iCal feed of bookings. Subscribe in Google/Apple/Outlook:
      https://yourdomain.com/admin/ical/<token>.ics
    """
    from flask import current_app
    expected_token = current_app.config.get('ICAL_TOKEN', 'studio-calendar-feed')
    if token != expected_token:
        return 'Unauthorized', 401

    bookings_list = (
        Booking.query
        .filter(
            Booking.status.in_(['confirmed', 'completed']),
            Booking.date >= date_type.today() - timedelta(days=90),
        )
        .order_by(Booking.date)
        .all()
    )

    blocked = (
        BlockedSlot.query
        .filter(BlockedSlot.date >= date_type.today() - timedelta(days=30))
        .all()
    )

    # Build iCal manually (no extra dependency needed)
    lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//The Visuals Photo Studio//Booking Calendar//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:The Visuals Photo Studio',
        'X-WR-TIMEZONE:America/New_York',
    ]

    for b in bookings_list:
        dtstart = datetime.combine(b.date, b.start_time)
        dtend = datetime.combine(b.date, b.end_time)
        uid = f'{b.booking_ref}@thevisualsphotostudio.com'

        lines.extend([
            'BEGIN:VEVENT',
            f'UID:{uid}',
            f'DTSTART:{dtstart.strftime("%Y%m%dT%H%M%S")}',
            f'DTEND:{dtend.strftime("%Y%m%dT%H%M%S")}',
            f'SUMMARY:{_ical_escape(b.customer_name)} - {_ical_escape(b.studio_names)}',
            f'DESCRIPTION:Ref: {b.booking_ref}\\nService: {b.service_type}\\n'
            f'Email: {b.customer_email}\\nPhone: {b.customer_phone or "N/A"}\\n'
            f'Total: ${b.total:.2f}\\nPayment: {b.payment_status}',
            f'STATUS:{"CONFIRMED" if b.status == "confirmed" else "TENTATIVE"}',
            'END:VEVENT',
        ])

    for bl in blocked:
        uid = f'block-{bl.id}@thevisualsphotostudio.com'
        studio_name = bl.studio.name if bl.studio else 'All Studios'
        if bl.is_full_day:
            lines.extend([
                'BEGIN:VEVENT',
                f'UID:{uid}',
                f'DTSTART;VALUE=DATE:{bl.date.strftime("%Y%m%d")}',
                f'DTEND;VALUE=DATE:{(bl.date + timedelta(days=1)).strftime("%Y%m%d")}',
                f'SUMMARY:BLOCKED - {_ical_escape(studio_name)}'
                + (f' ({_ical_escape(bl.note)})' if bl.note else ''),
                'STATUS:CANCELLED',
                'END:VEVENT',
            ])
        else:
            dtstart = datetime.combine(bl.date, bl.start_time)
            dtend = datetime.combine(bl.date, bl.end_time)
            lines.extend([
                'BEGIN:VEVENT',
                f'UID:{uid}',
                f'DTSTART:{dtstart.strftime("%Y%m%dT%H%M%S")}',
                f'DTEND:{dtend.strftime("%Y%m%dT%H%M%S")}',
                f'SUMMARY:BLOCKED - {_ical_escape(studio_name)}'
                + (f' ({_ical_escape(bl.note)})' if bl.note else ''),
                'STATUS:CANCELLED',
                'END:VEVENT',
            ])

    lines.append('END:VCALENDAR')

    ical_content = '\r\n'.join(lines)
    return Response(
        ical_content,
        mimetype='text/calendar',
        headers={'Content-Disposition': 'attachment; filename=studio-calendar.ics'}
    )


def _ical_escape(text):
    """Escape special iCal characters."""
    if not text:
        return ''
    return text.replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,').replace('\n', '\\n')


# ─── Settings ────────────────────────────────────────────────────────────────

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

    from flask import current_app
    ical_token = current_app.config.get('ICAL_TOKEN', 'studio-calendar-feed')
    ical_url = url_for('admin.ical_feed', token=ical_token, _external=True)

    return render_template('admin/settings.html', ical_url=ical_url)
