# The Visuals Photo Studio — Website

A custom Flask web application with integrated booking, Square payments, email confirmations, and admin dashboard.

---

## Quick Start

### 1. Install Python dependencies

```bash
# Create and activate a virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate      # Mac/Linux
# venv\Scripts\activate       # Windows

pip install -r requirements.txt
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Description |
|---|---|
| `SECRET_KEY` | Any long random string (e.g. run `python -c "import secrets; print(secrets.token_hex(32))"`) |
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_PASSWORD` | Admin login password |
| `MAIL_USERNAME` | Gmail address (or other SMTP) |
| `MAIL_PASSWORD` | Gmail App Password ([guide](https://support.google.com/accounts/answer/185833)) |
| `STUDIO_EMAIL` | Where owner notifications go |
| `SQUARE_APPLICATION_ID` | From your Square Developer dashboard |
| `SQUARE_ACCESS_TOKEN` | From your Square Developer dashboard |
| `SQUARE_LOCATION_ID` | From your Square Developer dashboard |
| `SQUARE_ENVIRONMENT` | `sandbox` for testing, `production` for live |

> **Square setup:** Go to [developer.squareup.com](https://developer.squareup.com), create an app, and copy the credentials. Use **sandbox** mode while testing — no real charges are made.

### 3. Set up the database

```bash
# Initialize migrations
flask --app run db init
flask --app run db migrate -m "initial"
flask --app run db upgrade

# Seed studios and admin user
python seed.py
```

### 4. Run the development server

```bash
python run.py
```

Visit [http://localhost:5000](http://localhost:5000)

Admin panel: [http://localhost:5000/admin](http://localhost:5000/admin)

---

## Project Structure

```
app/
├── __init__.py          # Flask app factory
├── models.py            # Database models
├── email.py             # Email notifications
├── utils.py             # Pricing, availability, Square helpers
├── routes/
│   ├── main.py          # Public website routes
│   ├── booking.py       # Booking wizard + creation
│   ├── admin.py         # Admin dashboard (login-protected)
│   └── api.py           # JSON API (availability, pricing)
├── templates/
│   ├── base.html        # Site-wide layout (nav, footer)
│   ├── index.html       # Home page
│   ├── studios.html     # Studios overview
│   ├── studio_detail.html
│   ├── services.html
│   ├── rates.html
│   ├── faq.html
│   ├── policies.html
│   ├── contact.html
│   ├── book.html        # Multi-step booking wizard
│   ├── booking_confirm.html
│   └── admin/           # Admin templates
└── static/
    ├── css/style.css    # All brand styles (CSS variables at top)
    └── js/              # Booking wizard JS is inline in book.html
config.py                # App configuration (reads from .env)
seed.py                  # One-time database setup
run.py                   # Entry point
```

---

## Booking Flow

1. **Select Studios** — choose 1, 2, or 3 studios (bundle = 10% off)
2. **Choose Service** — rental, photography ($300/hr), or content creation ($200/hr)
3. **Pick Date & Duration** — live price shown as you select
4. **Choose Time Slot** — only shows available times (server-verified)
5. **Your Details** — name, email, phone, notes
6. **Payment** — pay deposit (30%) or full via Square
7. **Confirmation** — booking confirmed, emails sent to customer + owner

---

## Admin Dashboard (`/admin`)

| Feature | Description |
|---|---|
| **Dashboard** | Upcoming bookings, monthly revenue, quick stats |
| **Bookings** | Full list, filter by date/status, cancel/complete |
| **Availability** | Block dates or specific time slots per studio |
| **Studios** | Update hourly rates |
| **Settings** | Change admin password |

---

## Customization

### Change prices
Go to `/admin` → **Studios** → update the hourly rate.

### Change bundle discount or deposit %
Edit `.env`:
```
BUNDLE_DISCOUNT_PCT=10   # % discount for booking multiple studios
DEPOSIT_PCT=30           # % of total charged as deposit
```

### Change booking slot interval
```
SLOT_INCREMENT_MINUTES=60   # 60 = top-of-hour only, 30 = every half hour
```

### Customize text / policies / FAQ
Edit the HTML templates in `app/templates/`. They're plain HTML with Jinja2 tags (`{{ variable }}` and `{% block %}`).

### Change colors / fonts
All brand variables are at the top of `app/static/css/style.css`:
```css
:root {
  --color-rose: #C8A882;      /* primary gold/tan */
  --color-cream: #F9F5F0;     /* page background */
  --color-dark: #2C2420;      /* headlines */
  /* ... */
}
```

---

## Deployment

For production, use **Gunicorn** + **Nginx** on a VPS (DigitalOcean, Linode, etc.):

```bash
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:8000 "run:app"
```

Set `FLASK_ENV=production` and `SQUARE_ENVIRONMENT=production` in `.env`.

---

## Email Setup (Gmail)

1. Enable 2-Step Verification on your Google account
2. Go to Google Account → Security → App Passwords
3. Create an App Password for "Mail"
4. Use that password as `MAIL_PASSWORD` in `.env`

```
MAIL_SERVER=smtp.gmail.com
MAIL_PORT=587
MAIL_USE_TLS=true
MAIL_USERNAME=youremail@gmail.com
MAIL_PASSWORD=xxxx xxxx xxxx xxxx
```

---

## Support

For bugs or questions, check the Flask documentation at [flask.palletsprojects.com](https://flask.palletsprojects.com).
