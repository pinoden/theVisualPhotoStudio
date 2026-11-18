-- Replace only the original bundle copy. Keep all other blocks, drafts and versions.
WITH rewritten AS (
  SELECT id, CASE built_in
    WHEN 'home' THEN replace(
      replace(body, 'Each studio has its own look. Book one, or any combination of them for the same time.',
                    'Each studio has its own look. Book a single studio or reserve a bundle for the same time.'),
      'Add any other studio to the same booking. The multi-studio discount applies automatically.',
      'Book Paris with Blanche, Paris with Dayglow or all three studios together.'
    )
    WHEN 'rates' THEN replace(
      replace(body, '"Book Any Studios Together"', '"Book Studio Bundles"'),
      'Select any combination of studios in one booking. Each is reserved for you for the whole session. {several studios offer}.',
      'Book Paris with Blanche, Paris with Dayglow or all three. Each studio is reserved for the whole session. {several studios offer}.'
    )
    WHEN 'faq' THEN replace(
      body,
      '<p>Yes. Select any combination of studios in one booking; each is reserved for you for the whole session.</p>',
      '<p>Yes. Book Paris with Blanche, Paris with Dayglow or all three. Each studio is reserved for you for the whole session.</p>'
    )
  END::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE built_in IN ('home', 'rates', 'faq')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Updated studio bundle wording'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
