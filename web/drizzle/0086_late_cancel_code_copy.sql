-- The owner, 2026-11-28: cancelled less than the refund window but at least two days before the start, a client gets
-- what they paid as a credit code; later, nothing, and an emergency is the owner's to refund. The rule is the settings
-- cancelCodeEnabled and cancelCodeUntilHours, and each booking keeps them with its terms. This tells it on the pages of
-- a database that already has them: the guest information's line about a cancellation closer to the start, and two
-- lines in the policies' list, each where the line it changes or follows still reads as the site wrote it. A page the
-- owners reworded there is left as they wrote it, and so is one that has the lines already.
WITH rewritten AS (
  SELECT id, replace(replace(body,
      '<li>Closer to the start than that, a cancellation is not refunded.</li>',
      '<li>{if not cancel code}Closer to the start than that, a cancellation is not refunded.</li><li>{if cancel code}Cancel later than that, but {cancel code until} or more before your start time, and nothing goes back to your card: what you paid is given to you as a credit code for a new booking, valid for {reschedule code valid}.</li><li>{if cancel code}Cancel less than {cancel code until} before your start time and nothing is refunded or credited. In a real emergency, contact us.</li>'),
      '<li>{if not moving}Cancellations made less than {refund window} before the appointment are non-refundable.</li>',
      '<li>{if not moving}Cancellations made less than {refund window} before the appointment are non-refundable.</li><li>{if cancel code}Cancellations made less than {refund window} but {cancel code until} or more before the appointment are not refunded to the card: the amount paid is returned as a credit code for a new booking, valid for {reschedule code valid}.</li><li>{if cancel code}Cancellations made less than {cancel code until} before the appointment receive no refund or credit. A real emergency may be refunded at the owner''s discretion.</li>')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL
    AND position('{if cancel code}' in body) = 0
    AND (body LIKE '%<li>Closer to the start than that, a cancellation is not refunded.</li>%'
      OR body LIKE '%<li>{if not moving}Cancellations made less than {refund window} before the appointment are non-refundable.</li>%')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'A late cancellation gets a credit code'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
