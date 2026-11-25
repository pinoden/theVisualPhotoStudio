-- The owner's brief of 2026-11-24, item 4, and answers of 2026-11-25: the bundles' prices on the Rates page. The rates page
-- the site started with (`rates`) gets, after the studios' prices, the section the starting page now has there: "Studio
-- Bundles", with the new block "Prices of the bundles", which reads each bundle's prices from Admin → Prices (migration
-- 0071 put the owner's there). Shown only while a bundle has prices of its own. The section "Book Studio Bundles" that
-- says the percentage off stays, and shows itself only while a bundle is a percentage off, as before. A page without the
-- studios' prices gets the section at its end; one that already has the bundles' prices is left as it is; a draft gets
-- it too, so that publishing it does not take the section off.
WITH section AS (SELECT '{"type":"Section","props":{"content":[{"type":"Heading","props":{"text":"Studio Bundles","level":"h2","size":"normal","eyebrow":"Several Studios","line":true,"align":"center","alignPhone":"","when":"","id":"rates-16"}},{"type":"Text","props":{"text":"<p style=\"text-align: center\">Book Paris with Blanche, Paris with Dayglow or all three. Each studio is reserved for the whole session. Bundle prices are the same on weekdays and weekends.</p>","size":"normal","width":"narrow","when":"","id":"rates-17"}},{"type":"BundlePrices","props":{"bookLabel":"Book Now","when":"","id":"rates-18"}}],"background":"card","width":"wide","space":"normal","spacePhone":"","anchor":"bundles","when":"bundle prices","id":"rates-19"}}'::jsonb AS block),
changes AS (
  SELECT document.id,
    CASE WHEN document.draft IS NOT NULL AND jsonb_typeof(document.draft->'blocks') = 'array' AND position('"BundlePrices"' in document.draft::text) = 0
      THEN coalesce(
        (SELECT jsonb_insert(document.draft, ARRAY['blocks', (min(item.place) - 1)::text], section.block, true)
         FROM jsonb_array_elements(document.draft->'blocks') WITH ORDINALITY AS item(block, place)
         WHERE position('"RateCards"' in item.block::text) > 0
         HAVING min(item.place) IS NOT NULL),
        jsonb_set(document.draft, '{blocks}', (document.draft->'blocks') || jsonb_build_array(section.block)))
      ELSE document.draft END AS draft,
    CASE WHEN document.published IS NOT NULL AND jsonb_typeof(document.published->'blocks') = 'array' AND position('"BundlePrices"' in document.published::text) = 0
      THEN coalesce(
        (SELECT jsonb_insert(document.published, ARRAY['blocks', (min(item.place) - 1)::text], section.block, true)
         FROM jsonb_array_elements(document.published->'blocks') WITH ORDINALITY AS item(block, place)
         WHERE position('"RateCards"' in item.block::text) > 0
         HAVING min(item.place) IS NOT NULL),
        jsonb_set(document.published, '{blocks}', (document.published->'blocks') || jsonb_build_array(section.block)))
      ELSE document.published END AS published
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'The bundles'' prices'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
