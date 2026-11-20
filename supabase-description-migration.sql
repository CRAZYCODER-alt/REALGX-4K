-- Run this once in Supabase SQL Editor for an existing REALGX 4K database.
-- Safe to run more than once.
alter table public.wallpapers
add column if not exists description text not null default '';
