-- Conversation snapshots reuse HTML page TTL and store immutable media copies privately.
alter table public.html_pages add column share_media_prefix text;
alter table public.html_pages add column is_snapshot boolean not null default false;
alter table public.html_pages add constraint html_pages_share_media_prefix_format
  check (share_media_prefix is null or share_media_prefix ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$');
create unique index html_pages_share_media_prefix_uidx on public.html_pages (share_media_prefix)
  where share_media_prefix is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('conversation-share-media', 'conversation-share-media', false, 104857600,
  array['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','image/svg+xml','image/x-icon',
        'audio/wav','audio/mp4','audio/webm','audio/ogg','audio/flac','audio/mpeg','audio/aac',
        'video/mp4','video/webm','video/quicktime']);

create policy "conversation_share_media_insert_own" on storage.objects
for insert to authenticated with check (
  bucket_id = 'conversation-share-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}$'
  and not exists (select 1 from public.html_pages p
    where p.share_media_prefix = (storage.foldername(name))[1] || '/' || (storage.foldername(name))[2])
);
create policy "conversation_share_media_select_own" on storage.objects
for select to authenticated using (
  bucket_id = 'conversation-share-media' and (storage.foldername(name))[1] = (select auth.uid())::text
);
create policy "conversation_share_media_delete_unpublished" on storage.objects
for delete to authenticated using (
  bucket_id = 'conversation-share-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not exists (select 1 from public.html_pages p
    where p.share_media_prefix = (storage.foldername(name))[1] || '/' || (storage.foldername(name))[2])
);
