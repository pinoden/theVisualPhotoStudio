-- The owner's brief of 2026-11-22 (the admin calendar, item 1): the website's menu says "Log In" in place of
-- "My Bookings", and "My Account" once the visitor is signed in (the site does that, not the stored menu). The
-- menu the site starts with changed with this migration (src/lib/site/frame.ts). What this does is tell it in a
-- database that already has the owners' own menu: an item that still says "My Bookings" and leads to /account says
-- "Log In"; and the two answers of the guest information that send clients to "My Bookings" send them to their
-- account. Only the original words are replaced. Keep all other items, blocks, drafts and versions.
WITH rewritten AS (
  SELECT id, CASE
    WHEN kind = 'frame' THEN replace(body, '"href": "/account", "label": "My Bookings"', '"href": "/account", "label": "Log In"')
    ELSE replace(
      replace(
        body,
        '<li>Cancel from the link in your confirmation email, or from My Bookings.</li>',
        '<li>Cancel from the link in your confirmation email, or from your account (Log In, at the top of the page).</li>'
      ),
      'Press Reschedule on your booking page or in My Bookings.',
      'Press Reschedule on your booking page or in your account (Log In, at the top of the page).'
    )
  END::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL AND ((kind = 'frame' AND slug = '') OR built_in = 'faq')
),
changes AS (
  SELECT id, nullif(content->'draft', 'null'::jsonb) AS draft,
    nullif(content->'published', 'null'::jsonb) AS published
  FROM rewritten
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'The menu says Log In'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
