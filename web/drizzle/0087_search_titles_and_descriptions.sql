-- The owner, 2026-11-28: "optimize each page for search engines". Each page the site starts with gets a title for
-- search results and a description under it, as the pages a new database starts with have them (SEARCH in
-- src/lib/site/built-in-pages.ts). Only where the owners have written neither, in what is published and in a draft
-- that waits; a page with a title or a description of their own is left as it is. The owners change both in the page
-- editor. A published page that changes gets a version, as a publish does.
WITH seo(key, title, description) AS (VALUES
  ('home', 'Winter Park Photo Studio Rental | The Visuals Photo Studio', 'Three natural-light photo studios in Winter Park, FL, rented by the hour. Book Studio Blanche, Dayglow or Paris online for shoots, content and family sessions.'),
  ('studios', 'Studio Blanche, Dayglow & Paris | The Visuals Photo Studio', 'See Studio Blanche, Studio Dayglow and Studio Paris: three natural-light studios in Winter Park, FL. Photos, what each includes, and how many guests each takes.'),
  ('rates', 'Photo Studio Rates in Winter Park | The Visuals Photo Studio', 'Hourly rates for The Visuals Photo Studio in Winter Park: each studio alone, studios booked together, weekday and weekend prices, and photography sessions.'),
  ('services', 'Photographer in Winter Park, FL | The Visuals Photo Studio', 'Book a session with our in-house photographer at The Visuals Photo Studio, Winter Park. Studio time is included; edited images arrive within 7 to 14 days.'),
  ('faq', 'Guest Information & FAQ | The Visuals Photo Studio', 'Before your visit to The Visuals Photo Studio: booking, cancelling and rescheduling, parking, pets, guests, equipment and studio rules, answered.'),
  ('policies', 'Studio Policies | The Visuals Photo Studio', 'The Visuals Photo Studio’s rental policies: cancellations and rescheduling, rental time, guests, pets, food, equipment and care of the space.'),
  ('memberships', 'Studio Memberships in Winter Park | The Visuals Photo Studio', 'Monthly studio memberships at The Visuals Photo Studio in Winter Park: studio hours every month for photographers and creators who shoot often.'),
  ('contact', 'Contact & Location | The Visuals Photo Studio', 'Contact The Visuals Photo Studio in Winter Park, FL: ask about bookings and after-hours rentals, or find the studio on the map.')
),
changes AS (
  SELECT d.id,
    CASE WHEN d.published IS NOT NULL AND coalesce(d.published->'meta'->>'title', '') = '' AND coalesce(d.published->'meta'->>'description', '') = ''
      THEN jsonb_set(d.published, '{meta}', coalesce(d.published->'meta', '{}'::jsonb) || jsonb_build_object('title', seo.title, 'description', seo.description), true)
      ELSE d.published END AS published,
    CASE WHEN d.draft IS NOT NULL AND coalesce(d.draft->'meta'->>'title', '') = '' AND coalesce(d.draft->'meta'->>'description', '') = ''
      THEN jsonb_set(d.draft, '{meta}', coalesce(d.draft->'meta', '{}'::jsonb) || jsonb_build_object('title', seo.title, 'description', seo.description), true)
      ELSE d.draft END AS draft
  FROM site_documents d
  JOIN seo ON seo.key = d.built_in
  WHERE d.deleted_at IS NULL
),
applied AS (
  UPDATE site_documents AS document
  SET draft = changes.draft,
    draft_revision = document.draft_revision + CASE WHEN changes.draft IS DISTINCT FROM document.draft THEN 1 ELSE 0 END,
    published = changes.published,
    published_by = CASE WHEN changes.published IS DISTINCT FROM document.published THEN 'the site' ELSE document.published_by END,
    published_at = CASE WHEN changes.published IS DISTINCT FROM document.published THEN now() ELSE document.published_at END
  FROM changes
  JOIN site_documents AS original ON original.id = changes.id
  WHERE document.id = changes.id
    AND (changes.published IS DISTINCT FROM original.published OR changes.draft IS DISTINCT FROM original.draft)
  RETURNING document.id, document.published, changes.published IS DISTINCT FROM original.published AS republished
)
INSERT INTO site_versions (document_id, number, content, published_by, note)
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'A title and a description for search engines'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
