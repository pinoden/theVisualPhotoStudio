from flask import Blueprint, render_template
from app.models import Studio, Announcement

main_bp = Blueprint('main', __name__)


@main_bp.app_context_processor
def inject_announcements():
    """Make active announcements available to all templates."""
    try:
        banners = Announcement.query.filter_by(is_active=True).all()
        active = [a for a in banners if a.is_currently_active]
    except Exception:
        active = []
    return dict(active_announcements=active)


@main_bp.route('/')
def index():
    studios = Studio.query.filter_by(is_active=True).all()
    return render_template('index.html', studios=studios)


@main_bp.route('/studios')
def studios():
    studios = Studio.query.filter_by(is_active=True).all()
    return render_template('studios.html', studios=studios)


@main_bp.route('/studios/<slug>')
def studio_detail(slug):
    studio = Studio.query.filter_by(slug=slug, is_active=True).first_or_404()
    return render_template('studio_detail.html', studio=studio)


@main_bp.route('/services')
def services():
    return render_template('services.html')


@main_bp.route('/rates')
def rates():
    studios = Studio.query.filter_by(is_active=True).all()
    return render_template('rates.html', studios=studios)


@main_bp.route('/faq')
def faq():
    return render_template('faq.html')


@main_bp.route('/policies')
def policies():
    return render_template('policies.html')


@main_bp.route('/contact')
def contact():
    return render_template('contact.html')
