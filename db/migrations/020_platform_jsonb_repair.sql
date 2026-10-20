-- Repair rows double-encoded by store-pg.ts ($N::jsonb on a pre-stringified param):
-- jsonb string scalars that hold a JSON object/array are unwrapped. Idempotent.
update platform_novelty set entry = (entry #>> '{}')::jsonb where jsonb_typeof(entry) = 'string' and (entry #>> '{}') ~ '^\s*[\[{]';
update platform_near_miss set items = (items #>> '{}')::jsonb where jsonb_typeof(items) = 'string' and (items #>> '{}') ~ '^\s*[\[{]';
update market_sectors set sectors = (sectors #>> '{}')::jsonb where jsonb_typeof(sectors) = 'string' and (sectors #>> '{}') ~ '^\s*[\[{]';
update opportunities set tags = (tags #>> '{}')::jsonb where jsonb_typeof(tags) = 'string' and (tags #>> '{}') ~ '^\s*[\[{]';
update opportunities set costs = (costs #>> '{}')::jsonb where jsonb_typeof(costs) = 'string' and (costs #>> '{}') ~ '^\s*[\[{]';
