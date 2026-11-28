-- The owner, 2026-11-28: "if the original booking was a weekday, they can't book for weekend". The code a client gets
-- for releasing a studio rental booked for a weekday works on weekdays only (Monday to Friday, not a holiday). The
-- rule is the setting weekdayCodeOnWeekdays (on in the code, so nothing is stored for it here), and each booking keeps
-- it with its terms. What this does is tell it on the pages of a database that already has them: a paragraph in the
-- guest information's answer about moving a booking, and a line in the policies' list after the line about a moved
-- booking, each where the line before it still reads as the site wrote it. A page the owners reworded there is left
-- as they wrote it, and so is one that already has the new line. Every other block, and the versions already
-- published, are kept.
WITH rewritten AS (
  SELECT id, replace(replace(body,
      '<p>{if not reschedule fee}A booking can be moved {reschedules allowed}.</p>',
      '<p>{if not reschedule fee}A booking can be moved {reschedules allowed}.</p><p>{if weekday moves}A studio rental booked for a weekday is moved to a weekday (Monday to Friday, not a holiday): its code does not work for a weekend.</p>'),
      '<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>',
      '<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li><li>{if weekday moves}A studio rental booked for a weekday can be rescheduled to another weekday only (Monday to Friday, not a holiday): its reschedule code cannot be used for a weekend.</li>')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL
    AND position('{if weekday moves}' in body) = 0
    AND (body LIKE '%<p>{if not reschedule fee}A booking can be moved {reschedules allowed}.</p>%'
      OR body LIKE '%<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>%')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'A weekday booking is moved to a weekday'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
