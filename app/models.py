from datetime import datetime, date, time
import secrets
from app import db, login_manager
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash


DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


# ─── Studio ─────────────────────────────────────────────────────────────────

class Studio(db.Model):
    __tablename__ = 'studio'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), nullable=False)           # "Studio Blanche"
    slug = db.Column(db.String(32), unique=True, nullable=False)  # "blanche"
    tagline = db.Column(db.String(128))
    description = db.Column(db.Text)
    hourly_rate = db.Column(db.Float, nullable=False)         # e.g. 88.0
    member_5h_rate = db.Column(db.Float)                      # 5-hour membership price
    member_10h_rate = db.Column(db.Float)                     # 10-hour membership price
    color_class = db.Column(db.String(32), default='studio-blanche')  # CSS class
    is_active = db.Column(db.Boolean, default=True)

    hours = db.relationship('StudioHours', backref='studio', cascade='all, delete-orphan')

    def __repr__(self):
        return f'<Studio {self.name}>'

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'slug': self.slug,
            'tagline': self.tagline,
            'hourly_rate': self.hourly_rate,
        }

    def hours_for_day(self, day_of_week):
        """Return StudioHours for a given weekday (0=Mon), or None."""
        for h in self.hours:
            if h.day_of_week == day_of_week:
                return h
        return None


class StudioHours(db.Model):
    __tablename__ = 'studio_hours'

    id = db.Column(db.Integer, primary_key=True)
    studio_id = db.Column(db.Integer, db.ForeignKey('studio.id'), nullable=False)
    # 0 = Monday ... 6 = Sunday
    day_of_week = db.Column(db.Integer, nullable=False)
    open_time = db.Column(db.Time, nullable=False)
    close_time = db.Column(db.Time, nullable=False)

    def to_dict(self):
        return {
            'day_of_week': self.day_of_week,
            'day_name': DAY_NAMES[self.day_of_week],
            'open_time': self.open_time.strftime('%H:%M'),
            'close_time': self.close_time.strftime('%H:%M'),
        }


# ─── Booking ─────────────────────────────────────────────────────────────────

booking_studio = db.Table(
    'booking_studio',
    db.Column('booking_id', db.Integer, db.ForeignKey('booking.id'), primary_key=True),
    db.Column('studio_id', db.Integer, db.ForeignKey('studio.id'), primary_key=True),
)


class Booking(db.Model):
    __tablename__ = 'booking'

    id = db.Column(db.Integer, primary_key=True)
    booking_ref = db.Column(db.String(12), unique=True, nullable=False,
                            default=lambda: 'VS-' + secrets.token_hex(4).upper())

    # Customer
    customer_name = db.Column(db.String(128), nullable=False)
    customer_email = db.Column(db.String(128), nullable=False)
    customer_phone = db.Column(db.String(32))
    notes = db.Column(db.Text)

    # Schedule
    date = db.Column(db.Date, nullable=False)
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    duration_hours = db.Column(db.Float, nullable=False)

    # Service
    service_type = db.Column(db.String(32), nullable=False, default='rental')
    # rental | photography | content

    # Pricing
    subtotal = db.Column(db.Float, nullable=False)
    discount_pct = db.Column(db.Float, default=0)
    discount_amount = db.Column(db.Float, default=0)
    total = db.Column(db.Float, nullable=False)
    deposit_amount = db.Column(db.Float, default=0)
    amount_paid = db.Column(db.Float, default=0)

    # Payment
    payment_status = db.Column(db.String(32), default='pending')
    # pending | deposit_paid | paid | refunded
    payment_id = db.Column(db.String(256))

    # Status
    status = db.Column(db.String(32), default='confirmed')
    # confirmed | cancelled | completed | no_show

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    studios = db.relationship('Studio', secondary=booking_studio, backref='bookings')

    def __repr__(self):
        return f'<Booking {self.booking_ref}>'

    @property
    def is_bundle(self):
        return len(self.studios) > 1

    @property
    def studio_names(self):
        return ', '.join(s.name for s in self.studios)

    def to_dict(self):
        return {
            'id': self.id,
            'booking_ref': self.booking_ref,
            'customer_name': self.customer_name,
            'customer_email': self.customer_email,
            'customer_phone': self.customer_phone,
            'date': self.date.isoformat(),
            'start_time': self.start_time.strftime('%H:%M'),
            'end_time': self.end_time.strftime('%H:%M'),
            'duration_hours': self.duration_hours,
            'service_type': self.service_type,
            'total': self.total,
            'payment_status': self.payment_status,
            'status': self.status,
            'studios': [s.to_dict() for s in self.studios],
        }


# ─── Blocked slots ───────────────────────────────────────────────────────────

class BlockedSlot(db.Model):
    __tablename__ = 'blocked_slot'

    id = db.Column(db.Integer, primary_key=True)
    # NULL studio_id = applies to ALL studios
    studio_id = db.Column(db.Integer, db.ForeignKey('studio.id'), nullable=True)
    date = db.Column(db.Date, nullable=False)
    # NULL start/end = full day blocked
    start_time = db.Column(db.Time, nullable=True)
    end_time = db.Column(db.Time, nullable=True)
    note = db.Column(db.String(256))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    studio = db.relationship('Studio', backref='blocked_slots')

    @property
    def is_full_day(self):
        return self.start_time is None


# ─── Announcements / Banners ────────────────────────────────────────────────

class Announcement(db.Model):
    __tablename__ = 'announcement'

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(128), nullable=False)
    message = db.Column(db.Text, nullable=False)
    link_url = db.Column(db.String(256))               # optional CTA link
    link_text = db.Column(db.String(64))                # e.g. "Book Now"
    bg_color = db.Column(db.String(32), default='#C8A882')  # banner background
    text_color = db.Column(db.String(32), default='#ffffff')
    is_active = db.Column(db.Boolean, default=True)
    start_date = db.Column(db.Date, nullable=True)      # show from this date (NULL = immediately)
    end_date = db.Column(db.Date, nullable=True)         # hide after this date (NULL = forever)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f'<Announcement {self.title}>'

    @property
    def is_currently_active(self):
        """Check if announcement should be shown right now."""
        if not self.is_active:
            return False
        today = date.today()
        if self.start_date and today < self.start_date:
            return False
        if self.end_date and today > self.end_date:
            return False
        return True


# ─── Admin user ──────────────────────────────────────────────────────────────

class AdminUser(db.Model, UserMixin):
    __tablename__ = 'admin_user'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def __repr__(self):
        return f'<AdminUser {self.username}>'


@login_manager.user_loader
def load_user(user_id):
    return AdminUser.query.get(int(user_id))
