-- 0003_storage_site_images.sql — admin image upload storage bucket
--
-- Creates the `site-images` Storage bucket the /admin image upload feature
-- writes to (src/server/storage.ts, src/lib/admin/fns/upload.ts,
-- src/components/admin/ImageField.tsx). image_key values pointing here are
-- prefixed "storage:" and resolved to a public URL by src/lib/images.ts.
--
-- Security model: public read, ZERO storage.objects policies.
--   - `public = true` lets the public site read images via
--     /storage/v1/object/public/site-images/<name> with no auth needed — that
--     public-read route bypasses RLS by design, so no SELECT policy is
--     required (or added).
--   - No INSERT/UPDATE/DELETE policy exists for this bucket, so RLS denies
--     every write from anon and authenticated. Only the service role
--     (supabaseAdmin(), used exclusively behind adminFnMiddleware) bypasses
--     RLS and can write — see src/server/storage.ts's doc comment.
--   - file_size_limit / allowed_mime_types are enforced by the Storage API
--     itself (independent of RLS) as a second line of defense behind the
--     app-level size check and magic-byte sniff in
--     src/server/storage.ts#uploadSiteImage().
--
-- Applied 2026-08-08 via the Supabase Management API's database/query
-- endpoint (POST /v1/projects/{ref}/database/query), not the Dashboard SQL
-- editor — see 0002_admin.sql's migration convention note for why this file
-- is committed even though the statement below already ran against the live
-- project: this repo is the source of truth, so what actually ran gets
-- recorded here too.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'site-images',
  'site-images',
  true,
  2097152, -- 2 MiB, mirrors MAX_UPLOAD_BYTES in src/server/storage.ts
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

commit;
