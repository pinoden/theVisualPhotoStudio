-- Add the policy as an editable block without replacing any of the owner's copy.
WITH note AS (
  SELECT $json$[{
    "type": "Section",
    "props": {
      "id": "policies-after-hours",
      "background": "page",
      "width": "narrow",
      "space": "small",
      "spacePhone": "",
      "anchor": "",
      "when": "",
      "content": [{
        "type": "Text",
        "props": {
          "id": "policies-after-hours-note",
          "text": "<p>After-hours bookings are available by request. Use the <a href=\"/contact\">contact form</a> and choose “After-hours booking”.</p>",
          "size": "normal",
          "width": "full",
          "when": ""
        }
      }]
    }
  }]$json$::jsonb AS block
), policy AS (
  SELECT page.id, page.published AS previous_published,
    CASE
      WHEN jsonb_typeof(page.published->'blocks') = 'array'
        AND NOT page.published @> '{"blocks":[{"props":{"id":"policies-after-hours"}}]}'
      THEN jsonb_set(page.published, '{blocks}', (page.published->'blocks') || note.block)
      ELSE page.published
    END AS published,
    CASE
      WHEN jsonb_typeof(page.draft->'blocks') = 'array'
        AND NOT page.draft @> '{"blocks":[{"props":{"id":"policies-after-hours"}}]}'
      THEN jsonb_set(page.draft, '{blocks}', (page.draft->'blocks') || note.block)
      ELSE page.draft
    END AS draft
  FROM site_documents AS page CROSS JOIN note
  WHERE page.kind = 'page' AND page.built_in = 'policies' AND page.deleted_at IS NULL
  FOR UPDATE OF page
), upgraded AS (
  UPDATE site_documents AS page
  SET published = policy.published,
      draft = policy.draft,
      draft_revision = page.draft_revision + 1,
      published_by = CASE WHEN page.published IS DISTINCT FROM policy.published THEN 'site update' ELSE page.published_by END,
      published_at = CASE WHEN page.published IS DISTINCT FROM policy.published THEN now() ELSE page.published_at END
  FROM policy
  WHERE page.id = policy.id
    AND (page.published IS DISTINCT FROM policy.published OR page.draft IS DISTINCT FROM policy.draft)
  RETURNING page.id, page.published, page.published_by, page.published_at,
            policy.previous_published IS DISTINCT FROM policy.published AS publish_changed
)
INSERT INTO site_versions (document_id, number, content, published_by, note, created_at)
SELECT upgraded.id, COALESCE(last.number, 0) + 1, upgraded.published, upgraded.published_by,
       'Added the after-hours booking policy', upgraded.published_at
FROM upgraded
CROSS JOIN LATERAL (SELECT max(number) AS number FROM site_versions WHERE document_id = upgraded.id) AS last
WHERE upgraded.publish_changed;
