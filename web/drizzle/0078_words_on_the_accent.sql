-- The owners' decision of 2026-11-27, on their decision of 2026-11-20 to make the tan readable: the buttons keep the
-- brand's tan, and the words on it become dark (#2c2420, 6.7 to 1) where they were white (2.2 to 1, and 4.5 is asked).
-- Words written in the accent get a darker shade of it, which is a new colour of the design: a design saved before
-- has none, and reads the site's own (#8e6a3e), so nothing is stored for that here.
--
-- What this does is change the words on the accent in a design the owners have already saved or published, and only
-- where both the accent and the words on it are still the site's original colours: a design in which they chose
-- either is left as they made it, and the design editor tells them what can be read. The versions already published
-- are kept, so the white words can be brought back from the design's history.
WITH changes AS (
  SELECT id,
    CASE WHEN lower(draft->'colors'->>'accent') = '#c8a882' AND lower(draft->'colors'->>'onAccent') = '#ffffff'
      THEN jsonb_set(draft, '{colors,onAccent}', '"#2c2420"') ELSE draft END AS draft,
    CASE WHEN lower(published->'colors'->>'accent') = '#c8a882' AND lower(published->'colors'->>'onAccent') = '#ffffff'
      THEN jsonb_set(published, '{colors,onAccent}', '"#2c2420"') ELSE published END AS published
  FROM site_documents
  WHERE kind = 'design' AND deleted_at IS NULL
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Dark words on the accent colour'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
