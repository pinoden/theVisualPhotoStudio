import os
from dotenv import load_dotenv

load_dotenv()

basedir = os.path.abspath(os.path.dirname(__file__))


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        'DATABASE_URL',
        'sqlite:///' + os.path.join(basedir, 'instance', 'studio.db')
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Admin credentials (stored hashed at first run via seed.py)
    ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
    ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'changeme')

    # Email
    MAIL_SERVER = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
    MAIL_PORT = int(os.environ.get('MAIL_PORT', 587))
    MAIL_USE_TLS = os.environ.get('MAIL_USE_TLS', 'true').lower() == 'true'
    MAIL_USERNAME = os.environ.get('MAIL_USERNAME')
    MAIL_PASSWORD = os.environ.get('MAIL_PASSWORD')
    STUDIO_EMAIL = os.environ.get('STUDIO_EMAIL', 'studio@thevisualsphotostudio.com')

    # Square
    SQUARE_ENVIRONMENT = os.environ.get('SQUARE_ENVIRONMENT', 'sandbox')
    SQUARE_APPLICATION_ID = os.environ.get('SQUARE_APPLICATION_ID', '')
    SQUARE_ACCESS_TOKEN = os.environ.get('SQUARE_ACCESS_TOKEN', '')
    SQUARE_LOCATION_ID = os.environ.get('SQUARE_LOCATION_ID', '')

    # Booking settings
    BUNDLE_DISCOUNT_PCT = int(os.environ.get('BUNDLE_DISCOUNT_PCT', 10))
    DEPOSIT_PCT = int(os.environ.get('DEPOSIT_PCT', 30))
    SLOT_INCREMENT_MINUTES = int(os.environ.get('SLOT_INCREMENT_MINUTES', 60))

    # Studio business hours (overridden per studio in DB)
    DEFAULT_WEEKDAY_OPEN = '09:00'
    DEFAULT_WEEKDAY_CLOSE = '19:00'
    DEFAULT_WEEKEND_OPEN = '08:00'
    DEFAULT_WEEKEND_CLOSE = '20:00'
