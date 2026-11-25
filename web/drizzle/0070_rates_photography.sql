-- The owner's brief of 2026-11-24, item 4: "Add pricing and package details for professional photography" to the Rates
-- page, "Ensure the displayed prices match the actual booking prices". The rates page the site started with (`rates`)
-- gets, at its end, the section the starting page now ends with: "Professional Photography", the sessions on sale with
-- their prices (the new block "Photography sessions and their prices", which reads them from Admin → Photography), and
-- a link to the photography page. Shown only while sessions are on sale. A page that already lists the sessions is left
-- as it is; a draft gets it too, so that publishing it does not take the section off.
WITH section AS (SELECT '{"type":"Section","props":{"content":[{"type":"Heading","props":{"text":"Professional Photography","level":"h2","size":"normal","eyebrow":"Services","line":true,"align":"center","alignPhone":"","when":"","id":"rates-11"}},{"type":"Text","props":{"text":"<p style=\"text-align: center\">Every package comes with the rental of the studio space, and each session is shot with a professional camera. Final images are delivered within 7 to 14 days.</p>","size":"normal","width":"narrow","when":"","id":"rates-12"}},{"type":"SessionPrices","props":{"service":"photography","bookLabel":"Book a Session","when":"","id":"rates-13"}},{"type":"Buttons","props":{"buttons":[{"label":"More About Photography","link":"/services","look":"outline"}],"align":"center","alignPhone":"","when":"","id":"rates-14"}}],"background":"card","width":"wide","space":"normal","spacePhone":"","anchor":"photography","when":"photography","id":"rates-15"}}'::jsonb AS block),
changes AS (
  SELECT document.id,
    CASE WHEN document.draft IS NOT NULL AND jsonb_typeof(document.draft->'blocks') = 'array' AND position('"SessionPrices"' in document.draft::text) = 0
      THEN jsonb_set(document.draft, '{blocks}', (document.draft->'blocks') || jsonb_build_array(section.block)) ELSE document.draft END AS draft,
    CASE WHEN document.published IS NOT NULL AND jsonb_typeof(document.published->'blocks') = 'array' AND position('"SessionPrices"' in document.published::text) = 0
      THEN jsonb_set(document.published, '{blocks}', (document.published->'blocks') || jsonb_build_array(section.block)) ELSE document.published END AS published
  FROM site_documents AS document, section
  WHERE document.kind = 'page' AND document.slug = 'rates' AND document.deleted_at IS NULL
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Professional Photography and its prices'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
