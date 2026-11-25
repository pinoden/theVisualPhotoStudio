-- The owner's brief of 2026-11-24, item 2: "Change 'Two Ways to Book' to 'Three Ways to Book,' since there are three
-- options", and "Make all three options fully clickable, directing customers to the corresponding service or booking
-- page". In the home page's words as the site started them: the heading becomes "Three Ways to Book", and each of the
-- three cards, under its original title, leads to its way of booking (a card's link is new: Cards' "Where pressing the
-- card leads"). A heading or a card the owners reworded is left as they wrote it, as are their drafts and versions.
WITH rewritten AS (
  SELECT id, replace(replace(replace(replace(body,
      '"text": "Two Ways to Book"', '"text": "Three Ways to Book"'),
      '"title": "Know the studio?"', '"link": "/book", "title": "Know the studio?"'),
      '"title": "Know the time?"', '"link": "/book?by=date", "title": "Know the time?"'),
      '"title": "Need more space?"', '"link": "/book?studio=paris", "title": "Need more space?"')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL
    AND (body LIKE '%"text": "Two Ways to Book"%' OR body LIKE '%"title": "Know the studio?"%' OR body LIKE '%"title": "Know the time?"%' OR body LIKE '%"title": "Need more space?"%')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Three Ways to Book, each card a link'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
