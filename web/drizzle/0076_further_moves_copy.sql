-- The owners' decision of 2026-11-20, built on 2026-11-27: a client moves a booking online only while a free move is
-- left, and each further move is the studio's to make, for the fee, which is added to what the booking owes. Until
-- now the fee came off a second reschedule code. This tells it on the pages of a database that already has them: the
-- guest information's answer about moving a booking, and the policies' line about a further reschedule.
-- Only the original wording is replaced: a sentence the owners reworded stays as they wrote it. Every other block,
-- and the versions already published, are kept.
WITH rewritten AS (
  SELECT id, replace(replace(body,
      'Moving it again costs {reschedule fee} each time, which is taken off the code.',
      'To move it again, contact the studio: each further move costs {reschedule fee}.'),
      'Each additional reschedule costs {reschedule fee}, which is deducted from the reschedule credit.',
      'Each additional reschedule is arranged with the studio and costs {reschedule fee}.')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL
    AND (body LIKE '%Moving it again costs {reschedule fee} each time, which is taken off the code.%'
      OR body LIKE '%Each additional reschedule costs {reschedule fee}, which is deducted from the reschedule credit.%')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'A further reschedule is arranged with the studio'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
