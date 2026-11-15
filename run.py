from app import create_app, db

app = create_app()

if __name__ == '__main__':
    import os
    use_ssl = os.environ.get('USE_SSL', 'false').lower() == 'true'
    ssl_ctx = 'adhoc' if use_ssl else None
    app.run(debug=True, use_reloader=True, reloader_type='stat', ssl_context=ssl_ctx)
