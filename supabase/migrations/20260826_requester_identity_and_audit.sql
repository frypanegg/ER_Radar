-- 운영 관리 코드를 없애고 신청자 신원을 받는다.
--
-- 코드 하나로 접수를 막으면 코드를 공유하는 순간 누가 넣었는지 알 수 없어지고, 코드를
-- 모르는 현업은 오탈자 하나도 알릴 수 없다. 신원은 인증이 아니므로 접수만으로 공개
-- 데이터가 바뀌지 않는 순서는 그대로 두고, 대장에 "누가"를 남긴다.

alter table public.company_add_requests
  add column if not exists requester_organization text,
  add column if not exists requester_company text,
  add column if not exists requester_job_title text,
  add column if not exists requester_phone text,
  add column if not exists requester_email text;

alter table public.bargaining_record_corrections
  add column if not exists requester_organization text,
  add column if not exists requester_company text,
  add column if not exists requester_job_title text,
  add column if not exists requester_phone text,
  add column if not exists requester_email text;

-- 수동 변경 이력.
--
-- 요청 대장은 "무엇을 요청했는지"를 담는다. 이 대장은 "공개 데이터의 무엇이 언제 어떻게
-- 바뀌었는지"를 담는다. 둘을 한 테이블에 섞으면 반려된 요청과 반영된 변경이 같은 줄에
-- 남아 나중에 되짚을 수 없다.
create table if not exists public.manual_change_audits (
  id uuid primary key default gen_random_uuid(),
  request_kind text not null check (request_kind in ('company', 'correction')),
  request_id uuid not null,
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  applied boolean not null default false,
  target_table text,
  target_id uuid,
  changed_column text,
  previous_value text,
  new_value text,
  requester_email text,
  requester_company text,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists manual_change_audits_request_idx
  on public.manual_change_audits (request_kind, request_id);
create index if not exists manual_change_audits_reviewed_at_idx
  on public.manual_change_audits (reviewed_at desc);

-- 다른 비공개 대장과 같은 규칙이다. 익명 역할은 이 테이블을 볼 수 없다.
alter table public.manual_change_audits enable row level security;
revoke all on public.manual_change_audits from anon;
