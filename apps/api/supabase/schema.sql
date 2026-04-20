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
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.users add column if not exists full_name text;

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

  -- Remove non-skating classes
  delete from public.community_classes
  where title in (
    'Neighborhood Pottery Basics',
    'Urban Garden 101',
    'Conversational Spanish for Travelers'
  );

  if not exists (
    select 1
    from public.community_classes
    where title = 'Beginner Skating'
      and starts_at = '2026-04-20T18:00:00Z'::timestamptz
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
      'Beginner Skating',
      'Learn the fundamentals of skating — balance, stopping, and basic forward strokes.',
      'Jordan Mills',
      'Riverside Ice Rink',
      '2026-04-20T18:00:00Z'::timestamptz,
      16
    );
  end if;

  if not exists (
    select 1
    from public.community_classes
    where title = 'Intermediate Skating'
      and starts_at = '2026-04-22T19:00:00Z'::timestamptz
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
      'Intermediate Skating',
      'Build on the basics with crossovers, backwards skating, and edge work.',
      'Sam Rivera',
      'Riverside Ice Rink',
      '2026-04-22T19:00:00Z'::timestamptz,
      14
    );
  end if;

  if not exists (
    select 1
    from public.community_classes
    where title = 'Advanced Skating'
      and starts_at = '2026-04-25T20:00:00Z'::timestamptz
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
      'Advanced Skating',
      'Master jumps, spins, and footwork sequences for competitive or recreational advancement.',
      'Alex Chen',
      'Riverside Ice Rink',
      '2026-04-25T20:00:00Z'::timestamptz,
      10
    );
  end if;
end $$;

-- Students are seeded automatically by the API on startup via seedStudentsIfNeeded()

-- Legacy cleanup: remove SQL-inserted fake students (replaced by API seeding)
do $$
declare
  beginner_id   uuid;
  intermediate_id uuid;
  advanced_id   uuid;
  student_ids   uuid[] := array[
    'a0000001-0000-0000-0000-000000000001'::uuid,
    'a0000001-0000-0000-0000-000000000002'::uuid,
    'a0000001-0000-0000-0000-000000000003'::uuid,
    'a0000001-0000-0000-0000-000000000004'::uuid,
    'a0000001-0000-0000-0000-000000000005'::uuid,
    'a0000001-0000-0000-0000-000000000006'::uuid,
    'a0000001-0000-0000-0000-000000000007'::uuid,
    'a0000001-0000-0000-0000-000000000008'::uuid,
    'a0000001-0000-0000-0000-000000000009'::uuid,
    'a0000001-0000-0000-0000-000000000010'::uuid
  ];
  student_emails text[] := array[
    'alex.turner@skate.test',
    'jordan.lee@skate.test',
    'sam.parker@skate.test',
    'riley.chen@skate.test',
    'casey.morgan@skate.test',
    'taylor.brooks@skate.test',
    'drew.williams@skate.test',
    'quinn.davis@skate.test',
    'avery.johnson@skate.test',
    'morgan.smith@skate.test'
  ];
  i integer;
begin
  -- Insert fake auth users
  for i in 1..10 loop
    begin
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
      ) values (
        '00000000-0000-0000-0000-000000000000',
        student_ids[i],
        'authenticated', 'authenticated',
        student_emails[i],
        crypt('SkatePass1!', gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}', '{}',
        false, false
      );
    exception when others then null;
    end;
  end loop;

  -- Insert into public.users as member
  for i in 1..10 loop
    insert into public.users (id, role)
    values (student_ids[i], 'member')
    on conflict (id) do nothing;
  end loop;

  -- Get class IDs
  select id into beginner_id     from public.community_classes where title = 'Beginner Skating'     limit 1;
  select id into intermediate_id from public.community_classes where title = 'Intermediate Skating' limit 1;
  select id into advanced_id     from public.community_classes where title = 'Advanced Skating'     limit 1;

  -- Enroll all 10 into Beginner
  if beginner_id is not null then
    for i in 1..10 loop
      insert into public.class_registrations (class_id, member_id)
      values (beginner_id, student_ids[i])
      on conflict (class_id, member_id) do nothing;
    end loop;
  end if;

  -- Enroll first 6 into Intermediate
  if intermediate_id is not null then
    for i in 1..6 loop
      insert into public.class_registrations (class_id, member_id)
      values (intermediate_id, student_ids[i])
      on conflict (class_id, member_id) do nothing;
    end loop;
  end if;

  -- Enroll first 4 into Advanced
  if advanced_id is not null then
    for i in 1..4 loop
      insert into public.class_registrations (class_id, member_id)
      values (advanced_id, student_ids[i])
      on conflict (class_id, member_id) do nothing;
    end loop;
  end if;
end $$;

-- Seed additional unenrolled students (available to add to classes)
do $$
declare
  extra_ids uuid[] := array[
    'b0000002-0000-0000-0000-000000000001'::uuid,
    'b0000002-0000-0000-0000-000000000002'::uuid,
    'b0000002-0000-0000-0000-000000000003'::uuid,
    'b0000002-0000-0000-0000-000000000004'::uuid,
    'b0000002-0000-0000-0000-000000000005'::uuid,
    'b0000002-0000-0000-0000-000000000006'::uuid,
    'b0000002-0000-0000-0000-000000000007'::uuid,
    'b0000002-0000-0000-0000-000000000008'::uuid,
    'b0000002-0000-0000-0000-000000000009'::uuid,
    'b0000002-0000-0000-0000-000000000010'::uuid,
    'b0000002-0000-0000-0000-000000000011'::uuid,
    'b0000002-0000-0000-0000-000000000012'::uuid,
    'b0000002-0000-0000-0000-000000000013'::uuid,
    'b0000002-0000-0000-0000-000000000014'::uuid,
    'b0000002-0000-0000-0000-000000000015'::uuid,
    'b0000002-0000-0000-0000-000000000016'::uuid,
    'b0000002-0000-0000-0000-000000000017'::uuid,
    'b0000002-0000-0000-0000-000000000018'::uuid,
    'b0000002-0000-0000-0000-000000000019'::uuid,
    'b0000002-0000-0000-0000-000000000020'::uuid
  ];
  extra_emails text[] := array[
    'blake.harris@skate.test',
    'charlie.nguyen@skate.test',
    'dana.kim@skate.test',
    'elliot.foster@skate.test',
    'fiona.reed@skate.test',
    'gabriel.stone@skate.test',
    'hailey.cross@skate.test',
    'ivan.bell@skate.test',
    'jade.warren@skate.test',
    'kai.murphy@skate.test',
    'lena.price@skate.test',
    'marcus.cole@skate.test',
    'nadia.hunt@skate.test',
    'oliver.shaw@skate.test',
    'paige.woods@skate.test',
    'rex.grant@skate.test',
    'sofia.lane@skate.test',
    'theo.banks@skate.test',
    'uma.hayes@skate.test',
    'victor.ross@skate.test'
  ];
  i integer;
begin
  for i in 1..20 loop
    begin
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
      ) values (
        '00000000-0000-0000-0000-000000000000',
        extra_ids[i],
        'authenticated', 'authenticated',
        extra_emails[i],
        crypt('SkatePass1!', gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}', '{}',
        false, false
      );
    exception when others then null;
    end;
  end loop;

  for i in 1..20 loop
    insert into public.users (id, role)
    values (extra_ids[i], 'member')
    on conflict (id) do nothing;
  end loop;
end $$;
