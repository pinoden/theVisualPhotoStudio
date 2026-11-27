-- The owners' decision of 2026-11-27: a discount code, free hour or studio credit a booking was made with comes back
-- only when the client cancels in time for a refund. Cancelled later, or after the booking was moved, it is used up,
-- as money paid is kept then. Until now it came back after any cancellation. The rule is the setting
-- lateCancelKeepsCode (off in the code, so nothing is stored for it here), and each booking keeps it with its terms.
-- What this does is tell it on the pages of a database that already has them: a line in the guest information's
-- answer about cancelling, and a line in the policies' list, each after the line about a moved booking, where that
-- line still reads as the site wrote it. A page the owners reworded there is left as they wrote it, and so is one
-- that already has the new line. Every other block, and the versions already published, are kept.
WITH rewritten AS (
  SELECT id, replace(replace(body,
      '<li>{if moving}A booking that has been moved can no longer be refunded.</li>',
      '<li>{if moving}A booking that has been moved can no longer be refunded.</li><li>{if not codes kept late}A discount code, free hour or studio credit used for a booking comes back when you cancel in time for a refund. Cancelled later, or after the booking was moved, it is used up.</li>'),
      '<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>',
      '<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li><li>{if not codes kept late}A discount code, free hour or studio credit applied to an appointment is returned only when the appointment is cancelled in time for a refund. If it is cancelled later, or after it has been rescheduled, the code or credit is used up.</li>')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL
    AND position('{if not codes kept late}' in body) = 0
    AND (body LIKE '%<li>{if moving}A booking that has been moved can no longer be refunded.</li>%'
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'A code is used up by a late cancellation'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
