"""
Run once to populate the database with studios, hours, and an admin user.
Usage:
    python seed.py
"""
from datetime import time
from app import create_app, db
from app.models import Studio, StudioHours, AdminUser
from config import Config

app = create_app()

STUDIOS = [
    {
        'name': 'Studio Blanche',
        'slug': 'blanche',
        'tagline': 'A modern, all-white space with sleek design and natural light.',
        'description': (
            'Studio Blanche is our premium all-white studio, perfect for clean, minimalist '
            'shoots. Featuring white walls, modern furniture, and abundant natural light from '
            'floor-to-ceiling windows, this space adapts beautifully to any creative vision. '
            'Ideal for product photography, fashion shoots, headshots, and editorial work.'
        ),
        'hourly_rate': 88.0,
        'member_5h_rate': 330.0,
        'member_10h_rate': 600.0,
        'color_class': 'blanche',
    },
    {
        'name': 'Studio Dayglow',
        'slug': 'dayglow',
        'tagline': 'A natural, boho-style studio with warm sunlight and earthy tones.',
        'description': (
            'Studio Dayglow embraces warmth and nature. This boho-inspired space features '
            'warm wood tones, earthy textures, lush greenery, and gorgeous natural sunlight '
            'that creates soft, golden-hour vibes all day long. Perfect for lifestyle photography, '
            'brand campaigns, maternity shoots, and content creation.'
        ),
        'hourly_rate': 78.0,
        'member_5h_rate': 280.0,
        'member_10h_rate': 520.0,
        'color_class': 'dayglow',
    },
    {
        'name': 'Studio Paris',
        'slug': 'paris',
        'tagline': 'A romantic, vintage-inspired space with old-world charm.',
        'description': (
            'Studio Paris transports you to a Parisian apartment. With its cream loveseat, '
            'ornate fireplace mantel, vintage accents, and warm romantic lighting, this studio '
            'creates timeless imagery. Perfect for boudoir photography, engagement shoots, '
            'brand storytelling, and any shoot that calls for soft, romantic elegance.'
        ),
        'hourly_rate': 68.0,
        'member_5h_rate': 270.0,
        'member_10h_rate': 500.0,
        'color_class': 'paris',
    },
]

# Studio hours: Mon-Fri 9am-7pm, Sat-Sun 8am-8pm
WEEKDAY_HOURS = (time(9, 0), time(19, 0))
WEEKEND_HOURS = (time(8, 0), time(20, 0))


def seed():
    with app.app_context():
        db.create_all()

        # ── Studios ──────────────────────────────────────────────────────
        for s_data in STUDIOS:
            existing = Studio.query.filter_by(slug=s_data['slug']).first()
            if existing:
                print(f'Studio {s_data["name"]} already exists — skipping.')
                continue

            studio = Studio(
                name=s_data['name'],
                slug=s_data['slug'],
                tagline=s_data['tagline'],
                description=s_data['description'],
                hourly_rate=s_data['hourly_rate'],
                member_5h_rate=s_data.get('member_5h_rate'),
                member_10h_rate=s_data.get('member_10h_rate'),
                color_class=s_data['color_class'],
            )
            db.session.add(studio)
            db.session.flush()  # get ID

            # Add hours
            for day in range(5):  # Mon–Fri
                db.session.add(StudioHours(
                    studio_id=studio.id,
                    day_of_week=day,
                    open_time=WEEKDAY_HOURS[0],
                    close_time=WEEKDAY_HOURS[1],
                ))
            for day in range(5, 7):  # Sat–Sun
                db.session.add(StudioHours(
                    studio_id=studio.id,
                    day_of_week=day,
                    open_time=WEEKEND_HOURS[0],
                    close_time=WEEKEND_HOURS[1],
                ))
            print(f'Created studio: {studio.name}')

        # ── Admin user ───────────────────────────────────────────────────
        username = Config.ADMIN_USERNAME
        password = Config.ADMIN_PASSWORD

        existing_admin = AdminUser.query.filter_by(username=username).first()
        if existing_admin:
            print(f'Admin user "{username}" already exists — updating password.')
            existing_admin.set_password(password)
        else:
            admin = AdminUser(username=username)
            admin.set_password(password)
            db.session.add(admin)
            print(f'Created admin user: {username}')

        db.session.commit()
        print('\nDatabase seeded successfully.')
        print(f'\nAdmin login: username="{username}" password="{password}"')
        print('Change the password immediately after first login!')


if __name__ == '__main__':
    seed()
