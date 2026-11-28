-- The owner, 2026-11-28, of studio credit after a late cancellation: "we should not issue them studio credit right
-- away. We will decide it on case to case basics, so they should receive an email to contact the studio." The
-- cancellation's words and email say so since then (`codeOnCancelText` in src/server/manage.ts). This tells it on the
-- pages of a database that already has them: the line of migration 0077 in the guest information's answer about
-- cancelling and in the policies' list, each replaced where it still reads as the site wrote it. A page the owners
-- reworded there is left as they wrote it. Every other block, and the versions already published, are kept.
WITH rewritten AS (
  SELECT id, replace(replace(body,
      '<li>{if not codes kept late}A discount code, free hour or studio credit used for a booking comes back when you cancel in time for a refund. Cancelled later, or after the booking was moved, it is used up.</li>',
      '<li>{if not codes kept late}A discount code or free hour used for a booking comes back when you cancel in time for a refund. Cancelled later, or after the booking was moved, it is used up. Studio credit used for the booking does not come back by itself then: contact us, and we look at each case.</li>'),
      '<li>{if not codes kept late}A discount code, free hour or studio credit applied to an appointment is returned only when the appointment is cancelled in time for a refund. If it is cancelled later, or after it has been rescheduled, the code or credit is used up.</li>',
      '<li>{if not codes kept late}A discount code or free hour applied to an appointment is returned only when the appointment is cancelled in time for a refund. If it is cancelled later, or after it has been rescheduled, the code is used up. Studio credit applied to it is not returned automatically in that case: contact the studio, which decides each case.</li>')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL
    AND (body LIKE '%<li>{if not codes kept late}A discount code, free hour or studio credit used for a booking comes back when you cancel in time for a refund. Cancelled later, or after the booking was moved, it is used up.</li>%'
      OR body LIKE '%<li>{if not codes kept late}A discount code, free hour or studio credit applied to an appointment is returned only when the appointment is cancelled in time for a refund. If it is cancelled later, or after it has been rescheduled, the code or credit is used up.</li>%')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Studio credit after a late cancellation: contact the studio'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
