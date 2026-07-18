-- Keep DB path validation aligned with the client/server WebP-first, JPEG-fallback policy.
alter table public.bar_keepings
  drop constraint bar_keepings_image_path_check,
  add constraint bar_keepings_image_path_check
    check (image_path ~ '^keeping/[0-9]+-[0-9a-f]{24}/main[.](webp|jpg)$'),
  drop constraint bar_keepings_thumbnail_path_check,
  add constraint bar_keepings_thumbnail_path_check
    check (thumbnail_path ~ '^keeping/[0-9]+-[0-9a-f]{24}/thumb[.](webp|jpg)$');
