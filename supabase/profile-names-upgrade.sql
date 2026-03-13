alter table profiles
  add column if not exists first_name text,
  add column if not exists last_name text;
