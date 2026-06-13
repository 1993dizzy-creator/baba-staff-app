create table if not exists public.pos_category_group_mappings (
  id uuid primary key default gen_random_uuid(),
  category_name text not null unique,
  group_type text not null,
  display_name text null,
  note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text null,
  constraint pos_category_group_mappings_group_type_check
    check (group_type in ('food', 'drink', 'uncategorized'))
);

alter table public.pos_category_group_mappings enable row level security;

insert into public.pos_category_group_mappings (category_name, group_type)
values
  ('Pizza', 'food'),
  ('Món Ăn Hàn Quốc', 'food'),
  ('Hải Sản Khô & Đồ Ăn Vặt', 'food'),
  ('Món Chiên', 'food'),
  ('Salad', 'food'),
  ('Món Nướng Lò', 'food'),
  ('Đồ Ăn Nhẹ', 'food'),
  ('Món Ăn Chính', 'food'),
  ('Gà Rán', 'food'),
  ('Trái Cây', 'food'),
  ('Whisky', 'drink'),
  ('Classic Cocktail', 'drink'),
  ('Mix Drink', 'drink'),
  ('Gin & Vodka', 'drink'),
  ('Mocktail', 'drink'),
  ('Signature Cocktail', 'drink'),
  ('BABA Bottled Spirits', 'drink'),
  ('Tequila & Cognac', 'drink'),
  ('Re Fresher', 'drink'),
  ('Bia tươi', 'drink'),
  ('Drink', 'drink'),
  ('Shot Drink', 'drink'),
  ('Bia chai', 'drink'),
  ('Wine', 'drink'),
  ('Bia thủ công', 'drink'),
  ('Soju', 'drink'),
  ('Combo', 'uncategorized'),
  ('EVENT', 'uncategorized')
on conflict (category_name) do nothing;
