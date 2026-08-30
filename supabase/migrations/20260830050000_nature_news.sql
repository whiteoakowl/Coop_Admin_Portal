-- Student Portal > Nature News - a real request: "students can submit
-- descriptions and one image of something they discovered in nature...
-- main admin must approve. then it will appear on student portal
-- homepage." Same pending/approved/rejected review pattern as
-- photo_album_photos and babysitter_profiles (see those migrations'
-- own header comments) - one row per submission, member_id NOT unique
-- (a student can submit many discoveries over time, unlike
-- babysitter_profiles' one-per-student shape).
create table if not exists nature_news_posts (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  description text not null,
  image_key text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at text not null default now_text(),
  decided_at text,
  decided_by_account_id integer references member_accounts(id) on delete set null
);

create index if not exists nature_news_posts_member_id_idx on nature_news_posts (member_id);
create index if not exists nature_news_posts_status_idx on nature_news_posts (status);
