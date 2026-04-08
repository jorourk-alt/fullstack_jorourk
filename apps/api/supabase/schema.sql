create extension if not exists pgcrypto;

drop table if exists public.camps cascade;

do $$
begin
  create type public.user_role as enum ('admin', 'member', 'teacher');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null,
  created_at timestamptz not null default now()
);

create table if not exists public.community_classes (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.users(id) on delete cascade,
  title text not null,
  description text not null,
  instructor_name text not null,
  location text not null,
  starts_at timestamptz not null,
  capacity integer not null check (capacity > 0),
  teacher_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Upgrade path: add teacher_id to existing deployments
alter table public.community_classes
  add column if not exists teacher_id uuid references public.users(id) on delete set null;

create table if not exists public.class_registrations (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.community_classes(id) on delete cascade,
  member_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (class_id, member_id)
);

create index if not exists community_classes_created_idx
  on public.community_classes (created_at desc);

create index if not exists class_registrations_member_idx
  on public.class_registrations (member_id, created_at desc);

alter table public.users enable row level security;
alter table public.community_classes enable row level security;
alter table public.class_registrations enable row level security;

drop policy if exists "users_can_read_own_user_row" on public.users;
create policy "users_can_read_own_user_row"
  on public.users
  for select
  using (auth.uid() = id);

drop policy if exists "users_can_insert_own_user_row" on public.users;
create policy "users_can_insert_own_user_row"
  on public.users
  for insert
  with check (auth.uid() = id);

drop policy if exists "authenticated_users_can_read_classes" on public.community_classes;
create policy "authenticated_users_can_read_classes"
  on public.community_classes
  for select
  to authenticated
  using (true);

drop policy if exists "admins_can_insert_classes" on public.community_classes;
create policy "admins_can_insert_classes"
  on public.community_classes
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'admin'
    )
  );

drop policy if exists "members_can_read_own_registrations" on public.class_registrations;
create policy "members_can_read_own_registrations"
  on public.class_registrations
  for select
  to authenticated
  using (member_id = auth.uid());

drop policy if exists "members_can_register_once_per_class" on public.class_registrations;
create policy "members_can_register_once_per_class"
  on public.class_registrations
  for insert
  to authenticated
  with check (
    member_id = auth.uid()
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'member'
    )
  );

-- Attendance tracking
do $$
begin
  create type public.attendance_status as enum ('present', 'absent', 'late');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.community_classes(id) on delete cascade,
  member_id uuid not null references public.users(id) on delete cascade,
  session_date date not null,
  status public.attendance_status not null default 'present',
  marked_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique (class_id, member_id, session_date)
);

create index if not exists attendance_class_date_idx
  on public.attendance (class_id, session_date);

alter table public.attendance enable row level security;

drop policy if exists "teachers_can_manage_attendance" on public.attendance;
create policy "teachers_can_manage_attendance"
  on public.attendance
  for all
  to authenticated
  using (
    exists (
      select 1 from public.community_classes cc
      where cc.id = class_id and cc.teacher_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.community_classes cc
      where cc.id = class_id and cc.teacher_id = auth.uid()
    )
  );

drop policy if exists "admins_can_read_attendance" on public.attendance;
create policy "admins_can_read_attendance"
  on public.attendance
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

do $$
declare
  seed_user_id uuid;
begin
  select id
  into seed_user_id
  from public.users
  where role = 'admin'
  order by created_at asc
  limit 1;

  if seed_user_id is null then
    select id
    into seed_user_id
    from public.users
    order by created_at asc
    limit 1;
  end if;

  if seed_user_id is null then
    return;
  end if;

  if not exists (
    select 1
    from public.community_classes
    where title = 'Neighborhood Pottery Basics'
      and starts_at = '2026-03-20T22:30:00Z'::timestamptz
  ) then
    insert into public.community_classes (
      created_by,
      title,
      description,
      instructor_name,
      location,
      starts_at,
      capacity
    )
    values (
      seed_user_id,
      'Neighborhood Pottery Basics',
      'Learn wheel and hand-building fundamentals and take home two finished pieces.',
      'Avery Collins',
      'Riverside Arts Studio',
      '2026-03-20T22:30:00Z'::timestamptz,
      16
    );
  end if;

  if not exists (
    select 1
    from public.community_classes
    where title = 'Urban Garden 101'
      and starts_at = '2026-03-27T23:00:00Z'::timestamptz
  ) then
    insert into public.community_classes (
      created_by,
      title,
      description,
      instructor_name,
      location,
      starts_at,
      capacity
    )
    values (
      seed_user_id,
      'Urban Garden 101',
      'Build a container garden plan for balconies and small yards with seasonal crop tips.',
      'Maya Rios',
      'Maple Community Greenhouse',
      '2026-03-27T23:00:00Z'::timestamptz,
      24
    );
  end if;

  if not exists (
    select 1
    from public.community_classes
    where title = 'Conversational Spanish for Travelers'
      and starts_at = '2026-04-02T23:30:00Z'::timestamptz
  ) then
    insert into public.community_classes (
      created_by,
      title,
      description,
      instructor_name,
      location,
      starts_at,
      capacity
    )
    values (
      seed_user_id,
      'Conversational Spanish for Travelers',
      'Practice high-use travel phrases through guided roleplay and pronunciation drills.',
      'Diego Herrera',
      'Eastside Library - Room B',
      '2026-04-02T23:30:00Z'::timestamptz,
      20
    );
  end if;
end $$;
