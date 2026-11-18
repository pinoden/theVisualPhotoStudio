-- The owner's answer of 2026-11-17 (follow-up 6): the first reschedule is free, and each further one costs a fee,
-- $20, taken off the reschedule code. The fee is the setting rescheduleFeeCents, whose default came with this
-- migration, so nothing is stored here for it. What this does is tell it on the pages of a database that already
-- has them: the guest information's answer about moving a booking, and the policies' list about rescheduling.
-- Only the original wording is replaced. Keep all other blocks, drafts and versions.
WITH rewritten AS (
  SELECT id, CASE built_in
    WHEN 'faq' THEN replace(
      body,
      '<p>Yes, {reschedules allowed}, until {reschedule cutoff} before it starts. Press Reschedule on your booking page or in My Bookings. We release your time and email you a code worth what you paid, plus anything a discount code took off that booking, so the same booking at a new time costs nothing more. Book the new time and enter the code at checkout: if the new booking costs more you pay the difference, and if it costs less the rest stays on the code. The code is valid for {reschedule code valid}.</p>',
      '<p>Yes, until {reschedule cutoff} before it starts. Press Reschedule on your booking page or in My Bookings. We release your time and email you a code worth what you paid, plus anything a discount code took off that booking, so the same booking at a new time costs nothing more. Book the new time and enter the code at checkout: if the new booking costs more you pay the difference, and if it costs less the rest stays on the code. The code is valid for {reschedule code valid}.</p><p>{if reschedule fee}You can move a booking {reschedules allowed} free of charge. Moving it again costs {reschedule fee} each time, which is taken off the code.</p><p>{if not reschedule fee}A booking can be moved {reschedules allowed}.</p>'
    )
    WHEN 'policies' THEN CASE
      WHEN position('{if reschedule fee}' in body) > 0 THEN body
      ELSE replace(
        body,
        '<li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>',
        '<li>{if reschedule fee}An appointment may be rescheduled {reschedules allowed} at no additional charge. Each additional reschedule costs {reschedule fee}, which is deducted from the reschedule credit.</li><li>{if moving}Once an appointment has been rescheduled, it is no longer eligible for a refund.</li>'
      )
    END
  END::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE built_in IN ('faq', 'policies')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'A further reschedule costs a fee'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
