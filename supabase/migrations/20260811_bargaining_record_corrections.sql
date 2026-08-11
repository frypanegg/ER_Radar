-- 크롤링으로 쌓인 기록이 실제와 다를 수 있다. 사람이 고친 내용을 추적 가능하게 남기기
-- 위한 수정 요청 대장이다.
--
-- 원칙
--  1. 수정은 즉시 공개되지 않는다. PENDING으로 접수되고, 검토를 통과해야 공개 사실이 된다.
--     검증되지 않은 수정이 바로 공개되면 자동 수집보다 더 위험하다.
--  2. 누가·언제·무엇을 어떻게 고쳤는지 함께 남긴다. 이전값과 이후값을 모두 보존해야
--     되돌릴 수 있고, 근거 URL이 없으면 접수하지 않는다.
--  3. 관리 코드 원문은 저장하지 않는다. 서버가 검증한 시각만 남긴다.

CREATE TABLE public.bargaining_record_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 대상 식별. 시드 레코드 식별자와 법인·연도를 함께 남겨, DB 전환 전후 모두 추적된다.
  target_record_id text NOT NULL,
  company_id_key text NOT NULL,
  company_legal_name text NOT NULL,
  bargaining_year smallint NOT NULL CHECK (bargaining_year BETWEEN 2000 AND 2100),

  -- 무엇을 고치는가. 공개 사실에 직접 영향을 주는 필드만 허용한다.
  field_name text NOT NULL
    CHECK (field_name IN (
      'stage',
      'eventDate',
      'agreementType',
      'unionName',
      'title',
      'factSummary',
      'sourceUrl',
      'flowEvents'
    )),
  previous_value text,
  proposed_value text NOT NULL,

  -- 근거 없는 수정은 받지 않는다.
  evidence_url text NOT NULL CHECK (evidence_url ~ '^https?://'),
  reason text NOT NULL,

  -- 누가·언제. 편집자 표시명만 받고 이메일·계정 식별자는 저장하지 않는다.
  editor_name text NOT NULL,
  editor_note text,
  admin_code_verified_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),

  -- 검토 결과
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED')),
  review_note text,
  reviewed_at timestamptz,
  reviewed_by text,
  applied_at timestamptz,

  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 적용된 수정에는 반영 시각이 반드시 있어야 한다.
  CONSTRAINT applied_correction_has_timestamp
    CHECK (status <> 'APPLIED' OR applied_at IS NOT NULL)
);

-- 같은 대상·같은 필드에 대한 미검토 요청이 중복 쌓이지 않게 한다.
CREATE UNIQUE INDEX bargaining_record_corrections_pending_unique
  ON public.bargaining_record_corrections (target_record_id, field_name)
  WHERE status = 'PENDING';

CREATE INDEX bargaining_record_corrections_status_idx
  ON public.bargaining_record_corrections (status, submitted_at DESC);

CREATE INDEX bargaining_record_corrections_company_idx
  ON public.bargaining_record_corrections (company_id_key, bargaining_year);

-- 수정 대장은 공개 읽기 대상이 아니다. 익명·로그인 역할에 권한과 정책을 만들지 않는다.
ALTER TABLE public.bargaining_record_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bargaining_record_corrections FROM anon, authenticated;
GRANT ALL ON TABLE public.bargaining_record_corrections TO service_role;

COMMENT ON TABLE public.bargaining_record_corrections IS
  '사람이 제출한 교섭 기록 수정 요청 대장. PENDING 상태는 공개 사실이 아니며, 이전값·이후값·근거 URL·수정자·검증 시각을 함께 보존한다.';
