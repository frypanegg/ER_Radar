-- 한국 제조업 원청 직접고용 노조 교섭 대시보드 초기 스키마
--
-- 적용 전제
--   1) 대상 Supabase 프로젝트는 제품 소유자가 명시적으로 선택한다.
--   2) 이 파일은 초안이며, 현재 어떤 Supabase 프로젝트에도 적용하지 않았다.
--   3) 공개 대시보드는 선택 법인에 직접 고용된 근로자를 대표하는 노조 사건만 표시한다.
--
-- 보안 원칙
--   - public 스키마의 모든 테이블에서 RLS를 활성화한다.
--   - anon은 검증·공개된 사실 데이터만 SELECT할 수 있다.
--   - INSERT/UPDATE/DELETE는 service_role 또는 데이터베이스 소유자만 수행한다.
--   - 회사 추가 요청은 서버가 관리 코드 검증을 마친 뒤 service_role로 PENDING 행만 추가한다.
--     관리 코드는 이 데이터베이스에 저장하지 않는다.

BEGIN;

-- 상태·근거 값은 애플리케이션의 프레임워크와 같은 코드 체계를 사용한다.
-- 향후 값 확장은 CHECK 제약을 검토한 뒤 별도 마이그레이션으로 수행한다.

CREATE TABLE public.tracked_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  legal_entity_identifier text,
  industry text NOT NULL,
  coverage_tier text NOT NULL CHECK (coverage_tier IN ('CORE', 'EXPANDED', 'WATCH')),
  tracking_status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (tracking_status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  search_aliases text[] NOT NULL DEFAULT '{}',
  selection_rationale text[] NOT NULL DEFAULT '{}',
  display_order integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  verified_at timestamptz,
  last_fact_checked_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_published OR verification_status = 'VERIFIED')
);

CREATE TABLE public.union_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.tracked_companies(id) ON DELETE RESTRICT,
  -- 직접사용자 법인과 대시보드 대상 법인이 같아야 한다.
  direct_employer_company_id uuid NOT NULL REFERENCES public.tracked_companies(id) ON DELETE RESTRICT,
  union_name text NOT NULL,
  union_name_normalized text NOT NULL,
  affiliation text,
  bargaining_unit_name text,
  covered_worker_scope_name text NOT NULL,
  covered_worker_relation text NOT NULL
    CHECK (covered_worker_relation IN ('DIRECT', 'SUBCONTRACTED', 'DISPATCHED', 'SERVICE', 'MIXED', 'UNKNOWN')),
  scope_classification text NOT NULL
    CHECK (scope_classification IN (
      'PRIMARY_DIRECT_UNION',
      'SUBCONTRACTOR_UNION_EXCLUDED',
      'AFFILIATE_UNION_EXCLUDED',
      'MIXED_NEEDS_SPLIT',
      'UNKNOWN_REVIEW'
    )),
  include_in_primary_dashboard boolean NOT NULL DEFAULT false,
  direct_employment_evidence_summary text,
  scope_evidence_url text,
  scope_verified_at timestamptz,
  scope_review_rule_version text,
  member_count integer CHECK (member_count IS NULL OR member_count >= 0),
  member_count_as_of date,
  majority_union_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (majority_union_status IN ('YES', 'NO', 'UNKNOWN', 'NOT_APPLICABLE')),
  majority_numerator integer,
  majority_denominator integer,
  majority_evidence_url text,
  majority_verified_at timestamptz,
  is_representative_bargaining_union boolean,
  representative_verified_at timestamptz,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_until date,
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  source_tier text CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, union_name_normalized, valid_from),
  CHECK (direct_employer_company_id = company_id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK (scope_evidence_url IS NULL OR scope_evidence_url ~ '^https?://'),
  CHECK (majority_evidence_url IS NULL OR majority_evidence_url ~ '^https?://'),
  CHECK (
    (majority_union_status IN ('YES', 'NO')
      AND majority_numerator IS NOT NULL
      AND majority_denominator IS NOT NULL
      AND majority_denominator > 0
      AND majority_numerator >= 0
      AND majority_numerator <= majority_denominator
      AND majority_evidence_url IS NOT NULL)
    OR
    (majority_union_status IN ('UNKNOWN', 'NOT_APPLICABLE')
      AND majority_numerator IS NULL
      AND majority_denominator IS NULL)
  ),
  CHECK (majority_union_status <> 'YES' OR majority_numerator * 2 > majority_denominator),
  CHECK (majority_union_status <> 'NO' OR majority_numerator * 2 <= majority_denominator),
  CHECK (
    NOT include_in_primary_dashboard
    OR (
      scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
      AND direct_employer_company_id = company_id
    )
  ),
  CHECK (
    NOT is_published
    OR (
      verification_status = 'VERIFIED'
      AND include_in_primary_dashboard
      AND scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
    )
  )
);

CREATE TABLE public.bargaining_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.tracked_companies(id) ON DELETE RESTRICT,
  direct_employer_company_id uuid NOT NULL REFERENCES public.tracked_companies(id) ON DELETE RESTRICT,
  bargaining_year smallint NOT NULL CHECK (bargaining_year BETWEEN 2000 AND 2100),
  agreement_type text NOT NULL
    CHECK (agreement_type IN ('WAGE', 'CBA', 'INTEGRATED', 'SUPPLEMENTAL', 'WORKS_COUNCIL')),
  bargaining_level text NOT NULL
    CHECK (bargaining_level IN ('ENTERPRISE', 'WORKPLACE', 'GROUP', 'REGIONAL', 'INDUSTRY', 'MULTI_EMPLOYER', 'OTHER')),
  bargaining_unit_key text NOT NULL,
  bargaining_unit_name text NOT NULL,
  covered_worker_scope_key text NOT NULL,
  covered_worker_scope_name text NOT NULL,
  covered_worker_relation text NOT NULL
    CHECK (covered_worker_relation IN ('DIRECT', 'SUBCONTRACTED', 'DISPATCHED', 'SERVICE', 'MIXED', 'UNKNOWN')),
  scope_classification text NOT NULL
    CHECK (scope_classification IN (
      'PRIMARY_DIRECT_UNION',
      'SUBCONTRACTOR_UNION_EXCLUDED',
      'AFFILIATE_UNION_EXCLUDED',
      'MIXED_NEEDS_SPLIT',
      'UNKNOWN_REVIEW'
    )),
  include_in_primary_dashboard boolean NOT NULL DEFAULT false,
  scope_evidence_url text,
  scope_evidence_summary text,
  scope_verified_at timestamptz,
  scope_review_rule_version text,
  primary_stage text NOT NULL DEFAULT 'U'
    CHECK (primary_stage IN ('U', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8')),
  stage_observed_at timestamptz,
  case_status text NOT NULL DEFAULT 'OPEN'
    CHECK (case_status IN ('OPEN', 'AGREED', 'IMPLEMENTING', 'CLOSED', 'UNKNOWN')),
  customary_cycle_pattern text
    CHECK (customary_cycle_pattern IN ('ANNUAL_WAGE', 'ANNUAL_INTEGRATED', 'ALTERNATING_WAGE_AND_CBA', 'IRREGULAR', 'UNKNOWN')),
  current_fact_summary text,
  current_issue_summary text,
  latest_event_on date,
  latest_event_recorded_at timestamptz,
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  source_tier text CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, bargaining_year, agreement_type, bargaining_unit_key, covered_worker_scope_key),
  CHECK (direct_employer_company_id = company_id),
  CHECK (scope_evidence_url IS NULL OR scope_evidence_url ~ '^https?://'),
  CHECK (
    NOT include_in_primary_dashboard
    OR (
      agreement_type <> 'WORKS_COUNCIL'
      AND scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
      AND direct_employer_company_id = company_id
    )
  ),
  CHECK (
    NOT is_published
    OR (
      verification_status = 'VERIFIED'
      AND include_in_primary_dashboard
      AND scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
    )
  )
);

-- 한 교섭사건에 복수의 직접고용 노조가 참여할 수 있으므로 별도 연결 테이블로 관리한다.
CREATE TABLE public.bargaining_case_unions (
  bargaining_case_id uuid NOT NULL,
  company_id uuid NOT NULL,
  union_profile_id uuid NOT NULL,
  participation_role text NOT NULL
    CHECK (participation_role IN ('REPRESENTATIVE', 'PARTICIPATING', 'AUTONOMOUS', 'OBSERVING')),
  participation_verified_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bargaining_case_id, union_profile_id),
  FOREIGN KEY (bargaining_case_id, company_id)
    REFERENCES public.bargaining_cases(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (union_profile_id, company_id)
    REFERENCES public.union_profiles(id, company_id) ON DELETE RESTRICT
);

-- 노조 선거·집행부 교체 등 교섭에 영향을 줄 수 있는 운영 이슈를 사건과 분리해 보관한다.
CREATE TABLE public.union_governance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_profile_id uuid NOT NULL REFERENCES public.union_profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN (
      'ELECTION_ANNOUNCED', 'CANDIDATE_REGISTRATION', 'VOTING', 'RESULT_DECLARED',
      'LEADERSHIP_CHANGE', 'TERM_CHANGE', 'OTHER'
    )),
  event_status text NOT NULL DEFAULT 'REPORTED'
    CHECK (event_status IN ('SCHEDULED', 'IN_PROGRESS', 'REPORTED', 'CONFIRMED', 'CANCELLED')),
  occurred_on date,
  summary text NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  source_tier text CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_published OR verification_status = 'VERIFIED')
);

-- 단계 전환·결렬·조정·찬반투표·체결·이행 등 사실 단위의 타임라인이다.
CREATE TABLE public.bargaining_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bargaining_case_id uuid NOT NULL,
  company_id uuid NOT NULL,
  direct_employer_company_id uuid NOT NULL REFERENCES public.tracked_companies(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  stage_after text NOT NULL CHECK (stage_after IN ('U', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8')),
  occurred_on date,
  published_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  fact_summary text NOT NULL,
  proposal_summary text,
  vote_result_summary text,
  breakdown_reason_summary text,
  scope_classification text NOT NULL
    CHECK (scope_classification IN (
      'PRIMARY_DIRECT_UNION',
      'SUBCONTRACTOR_UNION_EXCLUDED',
      'AFFILIATE_UNION_EXCLUDED',
      'MIXED_NEEDS_SPLIT',
      'UNKNOWN_REVIEW'
    )),
  covered_worker_relation text NOT NULL
    CHECK (covered_worker_relation IN ('DIRECT', 'SUBCONTRACTED', 'DISPATCHED', 'SERVICE', 'MIXED', 'UNKNOWN')),
  include_in_primary_dashboard boolean NOT NULL DEFAULT false,
  scope_evidence_url text,
  scope_verified_at timestamptz,
  scope_review_rule_version text,
  source_tier text CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  is_published boolean NOT NULL DEFAULT false,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (bargaining_case_id, company_id)
    REFERENCES public.bargaining_cases(id, company_id) ON DELETE CASCADE,
  UNIQUE (bargaining_case_id, dedupe_key),
  CHECK (direct_employer_company_id = company_id),
  CHECK (scope_evidence_url IS NULL OR scope_evidence_url ~ '^https?://'),
  CHECK (
    NOT include_in_primary_dashboard
    OR (
      scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
      AND direct_employer_company_id = company_id
    )
  ),
  CHECK (
    NOT is_published
    OR (
      verification_status = 'VERIFIED'
      AND include_in_primary_dashboard
      AND scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
    )
  )
);

-- 교섭 쟁점은 사건별 다건 구조로 관리하여 결렬·재개·해결 과정을 동적으로 표시한다.
CREATE TABLE public.bargaining_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bargaining_case_id uuid NOT NULL REFERENCES public.bargaining_cases(id) ON DELETE CASCADE,
  issue_category text NOT NULL
    CHECK (issue_category IN (
      'WAGE', 'BONUS', 'PERFORMANCE_PAY', 'WORKING_HOURS', 'STAFFING', 'JOB_SECURITY',
      'SAFETY', 'WELFARE', 'RETIREMENT', 'SUBCONTRACTING', 'TECHNOLOGY_CHANGE', 'OTHER'
    )),
  issue_title text NOT NULL,
  issue_status text NOT NULL DEFAULT 'OPEN'
    CHECK (issue_status IN ('OPEN', 'PARTIALLY_RESOLVED', 'RESOLVED', 'WITHDRAWN', 'UNKNOWN')),
  union_position_summary text,
  employer_position_summary text,
  factual_summary text NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  source_tier text CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_published OR verification_status = 'VERIFIED')
);

-- 잠정합의안·찬반투표·조인 후의 변경 내용을 기존 대비 중심으로 구조화한다.
CREATE TABLE public.bargaining_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bargaining_case_id uuid NOT NULL REFERENCES public.bargaining_cases(id) ON DELETE CASCADE,
  bargaining_event_id uuid REFERENCES public.bargaining_events(id) ON DELETE SET NULL,
  term_category text NOT NULL
    CHECK (term_category IN (
      'BASE_WAGE', 'BONUS', 'PERFORMANCE_PAY', 'ALLOWANCE', 'WORKING_HOURS', 'WELFARE',
      'JOB_SECURITY', 'RETIREMENT', 'SAFETY', 'OTHER'
    )),
  baseline_description text,
  change_summary text NOT NULL,
  effective_on date,
  ratification_context text
    CHECK (ratification_context IN ('TENTATIVE_AGREEMENT', 'RATIFICATION', 'SIGNED', 'IMPLEMENTATION', 'OTHER')),
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  source_tier text CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_published OR verification_status = 'VERIFIED')
);

-- 기사 전문은 저장하지 않는다. 원문 URL·제목·발행 정보와 품질 메타데이터만 저장한다.
CREATE TABLE public.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_url text NOT NULL UNIQUE CHECK (original_url ~ '^https?://'),
  canonical_url text CHECK (canonical_url IS NULL OR canonical_url ~ '^https?://'),
  publisher_name text NOT NULL,
  publisher_domain text,
  source_type text NOT NULL
    CHECK (source_type IN ('OFFICIAL_EMPLOYER', 'OFFICIAL_UNION', 'PUBLIC_AGENCY', 'COURT_OR_COMMISSION', 'NEWS', 'OTHER')),
  headline text,
  source_published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  source_tier text NOT NULL CHECK (source_tier IN ('S', 'A', 'B', 'C')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  is_published boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_published OR verification_status = 'VERIFIED')
);

-- 공개 대시보드 밖의 후보·하청·혼합 기사는 이 감사 테이블에서만 검토한다.
CREATE TABLE public.scope_review_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.tracked_companies(id) ON DELETE CASCADE,
  source_id uuid REFERENCES public.sources(id) ON DELETE SET NULL,
  candidate_reference_url text CHECK (candidate_reference_url IS NULL OR candidate_reference_url ~ '^https?://'),
  candidate_title text,
  detected_direct_employer_name text,
  detected_direct_employer_company_id uuid REFERENCES public.tracked_companies(id) ON DELETE SET NULL,
  covered_worker_relation text NOT NULL
    CHECK (covered_worker_relation IN ('DIRECT', 'SUBCONTRACTED', 'DISPATCHED', 'SERVICE', 'MIXED', 'UNKNOWN')),
  scope_classification text NOT NULL
    CHECK (scope_classification IN (
      'PRIMARY_DIRECT_UNION',
      'SUBCONTRACTOR_UNION_EXCLUDED',
      'AFFILIATE_UNION_EXCLUDED',
      'MIXED_NEEDS_SPLIT',
      'UNKNOWN_REVIEW'
    )),
  include_in_primary_dashboard boolean NOT NULL DEFAULT false,
  decision_reason text NOT NULL,
  reviewer_type text NOT NULL CHECK (reviewer_type IN ('AGENT', 'HUMAN', 'HYBRID')),
  rule_version text NOT NULL,
  review_status text NOT NULL DEFAULT 'PENDING'
    CHECK (review_status IN ('PENDING', 'CONFIRMED', 'OVERRIDDEN', 'REJECTED')),
  reviewed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    NOT include_in_primary_dashboard
    OR (
      scope_classification = 'PRIMARY_DIRECT_UNION'
      AND covered_worker_relation = 'DIRECT'
      AND detected_direct_employer_company_id = company_id
    )
  )
);

-- 하나의 주석은 정확히 한 공개 대상에 연결한다. 주석은 기사 전문이 아닌 짧은 사실 메모다.
CREATE TABLE public.source_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.tracked_companies(id) ON DELETE CASCADE,
  union_profile_id uuid REFERENCES public.union_profiles(id) ON DELETE CASCADE,
  bargaining_case_id uuid REFERENCES public.bargaining_cases(id) ON DELETE CASCADE,
  bargaining_event_id uuid REFERENCES public.bargaining_events(id) ON DELETE CASCADE,
  union_governance_event_id uuid REFERENCES public.union_governance_events(id) ON DELETE CASCADE,
  bargaining_issue_id uuid REFERENCES public.bargaining_issues(id) ON DELETE CASCADE,
  bargaining_term_id uuid REFERENCES public.bargaining_terms(id) ON DELETE CASCADE,
  annotation_type text NOT NULL
    CHECK (annotation_type IN ('FACT', 'SCOPE_EVIDENCE', 'MAJORITY_EVIDENCE', 'ELECTION_EVIDENCE', 'CORRECTION', 'OTHER')),
  annotation_field text,
  fact_note text NOT NULL,
  is_scope_evidence boolean NOT NULL DEFAULT false,
  is_published boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_REVIEW', 'SUPERSEDED')),
  confidence_score numeric(4, 3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
  verified_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (CASE WHEN company_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN union_profile_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN bargaining_case_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN bargaining_event_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN union_governance_event_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN bargaining_issue_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN bargaining_term_id IS NULL THEN 0 ELSE 1 END)
    = 1
  ),
  CHECK (NOT is_published OR verification_status = 'VERIFIED')
);

-- 회사 추가 요청은 서버가 관리 코드를 검증한 다음에만 service_role로 생성한다.
-- 코드 원문·브라우저 세션·개인식별정보는 저장하지 않는다.
CREATE TABLE public.company_add_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_legal_name text NOT NULL,
  company_name text,
  industry text,
  website_url text CHECK (website_url IS NULL OR website_url ~ '^https?://'),
  rationale text,
  source_hint_url text CHECK (source_hint_url IS NULL OR source_hint_url ~ '^https?://'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'DUPLICATE', 'CANCELLED')),
  submitted_via text NOT NULL DEFAULT 'DASHBOARD_ADMIN_CODE'
    CHECK (submitted_via IN ('DASHBOARD_ADMIN_CODE', 'SERVER_IMPORT')),
  admin_code_verified_at timestamptz NOT NULL,
  request_dedupe_key text,
  review_note text,
  reviewed_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX company_add_requests_dedupe_key_unique
  ON public.company_add_requests (request_dedupe_key)
  WHERE request_dedupe_key IS NOT NULL;

-- 대시보드 읽기 경로에서 쓰는 인덱스. 모든 외래 키와 공개 필터를 포함한다.
CREATE INDEX tracked_companies_public_display_idx
  ON public.tracked_companies (display_order, legal_name)
  WHERE is_published;

CREATE INDEX union_profiles_company_public_idx
  ON public.union_profiles (company_id, valid_from DESC)
  WHERE is_published AND include_in_primary_dashboard;

CREATE INDEX bargaining_cases_company_year_stage_idx
  ON public.bargaining_cases (company_id, bargaining_year DESC, primary_stage, latest_event_on DESC NULLS LAST)
  WHERE is_published AND include_in_primary_dashboard;

CREATE INDEX bargaining_case_unions_union_idx
  ON public.bargaining_case_unions (union_profile_id, bargaining_case_id);

CREATE INDEX union_governance_events_union_occurred_idx
  ON public.union_governance_events (union_profile_id, occurred_on DESC NULLS LAST)
  WHERE is_published;

CREATE INDEX bargaining_events_case_occurred_idx
  ON public.bargaining_events (bargaining_case_id, occurred_on DESC NULLS LAST, recorded_at DESC)
  WHERE is_published AND include_in_primary_dashboard;

CREATE INDEX bargaining_issues_case_status_idx
  ON public.bargaining_issues (bargaining_case_id, issue_status)
  WHERE is_published;

CREATE INDEX bargaining_terms_case_idx
  ON public.bargaining_terms (bargaining_case_id, effective_on DESC NULLS LAST)
  WHERE is_published;

CREATE INDEX source_annotations_source_idx
  ON public.source_annotations (source_id)
  WHERE is_published;

CREATE INDEX source_annotations_case_idx
  ON public.source_annotations (bargaining_case_id)
  WHERE bargaining_case_id IS NOT NULL AND is_published;

CREATE INDEX source_annotations_event_idx
  ON public.source_annotations (bargaining_event_id)
  WHERE bargaining_event_id IS NOT NULL AND is_published;

CREATE INDEX scope_review_audits_review_queue_idx
  ON public.scope_review_audits (review_status, recorded_at DESC);

CREATE INDEX company_add_requests_status_idx
  ON public.company_add_requests (status, requested_at DESC);

-- 모든 public 테이블에 RLS를 켠다. 새 테이블도 이 원칙을 따라야 한다.
ALTER TABLE public.tracked_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bargaining_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bargaining_case_unions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_governance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bargaining_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bargaining_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bargaining_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_review_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_add_requests ENABLE ROW LEVEL SECURITY;

-- anon/authenticated에는 기본적으로 권한을 주지 않는다. service_role만 서버 측에서 쓴다.
REVOKE ALL ON TABLE public.tracked_companies FROM anon, authenticated;
REVOKE ALL ON TABLE public.union_profiles FROM anon, authenticated;
REVOKE ALL ON TABLE public.bargaining_cases FROM anon, authenticated;
REVOKE ALL ON TABLE public.bargaining_case_unions FROM anon, authenticated;
REVOKE ALL ON TABLE public.union_governance_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.bargaining_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.bargaining_issues FROM anon, authenticated;
REVOKE ALL ON TABLE public.bargaining_terms FROM anon, authenticated;
REVOKE ALL ON TABLE public.sources FROM anon, authenticated;
REVOKE ALL ON TABLE public.scope_review_audits FROM anon, authenticated;
REVOKE ALL ON TABLE public.source_annotations FROM anon, authenticated;
REVOKE ALL ON TABLE public.company_add_requests FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, service_role;
GRANT ALL ON TABLE public.tracked_companies TO service_role;
GRANT ALL ON TABLE public.union_profiles TO service_role;
GRANT ALL ON TABLE public.bargaining_cases TO service_role;
GRANT ALL ON TABLE public.bargaining_case_unions TO service_role;
GRANT ALL ON TABLE public.union_governance_events TO service_role;
GRANT ALL ON TABLE public.bargaining_events TO service_role;
GRANT ALL ON TABLE public.bargaining_issues TO service_role;
GRANT ALL ON TABLE public.bargaining_terms TO service_role;
GRANT ALL ON TABLE public.sources TO service_role;
GRANT ALL ON TABLE public.scope_review_audits TO service_role;
GRANT ALL ON TABLE public.source_annotations TO service_role;
GRANT ALL ON TABLE public.company_add_requests TO service_role;

-- anon은 공개·검증 완료된 사실 데이터만 읽는다. authenticated에는 별도 권한을 부여하지 않는다.
GRANT SELECT ON TABLE public.tracked_companies TO anon;
GRANT SELECT ON TABLE public.union_profiles TO anon;
GRANT SELECT ON TABLE public.bargaining_cases TO anon;
GRANT SELECT ON TABLE public.bargaining_case_unions TO anon;
GRANT SELECT ON TABLE public.union_governance_events TO anon;
GRANT SELECT ON TABLE public.bargaining_events TO anon;
GRANT SELECT ON TABLE public.bargaining_issues TO anon;
GRANT SELECT ON TABLE public.bargaining_terms TO anon;
GRANT SELECT ON TABLE public.sources TO anon;
GRANT SELECT ON TABLE public.source_annotations TO anon;

CREATE POLICY anon_read_published_companies
  ON public.tracked_companies
  FOR SELECT TO anon
  USING (is_published AND verification_status = 'VERIFIED');

CREATE POLICY anon_read_published_direct_union_profiles
  ON public.union_profiles
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND include_in_primary_dashboard
    AND scope_classification = 'PRIMARY_DIRECT_UNION'
    AND covered_worker_relation = 'DIRECT'
    AND direct_employer_company_id = company_id
  );

CREATE POLICY anon_read_published_direct_bargaining_cases
  ON public.bargaining_cases
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND include_in_primary_dashboard
    AND scope_classification = 'PRIMARY_DIRECT_UNION'
    AND covered_worker_relation = 'DIRECT'
    AND direct_employer_company_id = company_id
  );

CREATE POLICY anon_read_case_union_links_for_published_cases
  ON public.bargaining_case_unions
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM public.bargaining_cases bc
      WHERE bc.id = bargaining_case_unions.bargaining_case_id
        AND bc.company_id = bargaining_case_unions.company_id
        AND bc.is_published
        AND bc.verification_status = 'VERIFIED'
        AND bc.include_in_primary_dashboard
        AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
        AND bc.covered_worker_relation = 'DIRECT'
    )
    AND EXISTS (
      SELECT 1
      FROM public.union_profiles up
      WHERE up.id = bargaining_case_unions.union_profile_id
        AND up.company_id = bargaining_case_unions.company_id
        AND up.is_published
        AND up.verification_status = 'VERIFIED'
        AND up.include_in_primary_dashboard
        AND up.scope_classification = 'PRIMARY_DIRECT_UNION'
        AND up.covered_worker_relation = 'DIRECT'
    )
  );

CREATE POLICY anon_read_published_union_governance_events
  ON public.union_governance_events
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND EXISTS (
      SELECT 1
      FROM public.union_profiles up
      WHERE up.id = union_governance_events.union_profile_id
        AND up.is_published
        AND up.verification_status = 'VERIFIED'
        AND up.include_in_primary_dashboard
        AND up.scope_classification = 'PRIMARY_DIRECT_UNION'
        AND up.covered_worker_relation = 'DIRECT'
    )
  );

CREATE POLICY anon_read_published_direct_bargaining_events
  ON public.bargaining_events
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND include_in_primary_dashboard
    AND scope_classification = 'PRIMARY_DIRECT_UNION'
    AND covered_worker_relation = 'DIRECT'
    AND direct_employer_company_id = company_id
    AND EXISTS (
      SELECT 1
      FROM public.bargaining_cases bc
      WHERE bc.id = bargaining_events.bargaining_case_id
        AND bc.company_id = bargaining_events.company_id
        AND bc.is_published
        AND bc.verification_status = 'VERIFIED'
        AND bc.include_in_primary_dashboard
        AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
        AND bc.covered_worker_relation = 'DIRECT'
    )
  );

CREATE POLICY anon_read_published_bargaining_issues
  ON public.bargaining_issues
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND EXISTS (
      SELECT 1
      FROM public.bargaining_cases bc
      WHERE bc.id = bargaining_issues.bargaining_case_id
        AND bc.is_published
        AND bc.verification_status = 'VERIFIED'
        AND bc.include_in_primary_dashboard
        AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
        AND bc.covered_worker_relation = 'DIRECT'
    )
  );

CREATE POLICY anon_read_published_bargaining_terms
  ON public.bargaining_terms
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND EXISTS (
      SELECT 1
      FROM public.bargaining_cases bc
      WHERE bc.id = bargaining_terms.bargaining_case_id
        AND bc.is_published
        AND bc.verification_status = 'VERIFIED'
        AND bc.include_in_primary_dashboard
        AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
        AND bc.covered_worker_relation = 'DIRECT'
    )
  );

CREATE POLICY anon_read_published_source_annotations
  ON public.source_annotations
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND (
      (company_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.tracked_companies tc
        WHERE tc.id = source_annotations.company_id
          AND tc.is_published AND tc.verification_status = 'VERIFIED'
      ))
      OR
      (union_profile_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.union_profiles up
        WHERE up.id = source_annotations.union_profile_id
          AND up.is_published AND up.verification_status = 'VERIFIED'
          AND up.include_in_primary_dashboard
          AND up.scope_classification = 'PRIMARY_DIRECT_UNION'
          AND up.covered_worker_relation = 'DIRECT'
      ))
      OR
      (bargaining_case_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.bargaining_cases bc
        WHERE bc.id = source_annotations.bargaining_case_id
          AND bc.is_published AND bc.verification_status = 'VERIFIED'
          AND bc.include_in_primary_dashboard
          AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
          AND bc.covered_worker_relation = 'DIRECT'
      ))
      OR
      (bargaining_event_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.bargaining_events be
        WHERE be.id = source_annotations.bargaining_event_id
          AND be.is_published AND be.verification_status = 'VERIFIED'
          AND be.include_in_primary_dashboard
          AND be.scope_classification = 'PRIMARY_DIRECT_UNION'
          AND be.covered_worker_relation = 'DIRECT'
      ))
      OR
      (union_governance_event_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.union_governance_events uge
        JOIN public.union_profiles up ON up.id = uge.union_profile_id
        WHERE uge.id = source_annotations.union_governance_event_id
          AND uge.is_published AND uge.verification_status = 'VERIFIED'
          AND up.is_published AND up.verification_status = 'VERIFIED'
          AND up.include_in_primary_dashboard
          AND up.scope_classification = 'PRIMARY_DIRECT_UNION'
          AND up.covered_worker_relation = 'DIRECT'
      ))
      OR
      (bargaining_issue_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.bargaining_issues bi
        JOIN public.bargaining_cases bc ON bc.id = bi.bargaining_case_id
        WHERE bi.id = source_annotations.bargaining_issue_id
          AND bi.is_published AND bi.verification_status = 'VERIFIED'
          AND bc.is_published AND bc.verification_status = 'VERIFIED'
          AND bc.include_in_primary_dashboard
          AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
          AND bc.covered_worker_relation = 'DIRECT'
      ))
      OR
      (bargaining_term_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.bargaining_terms bt
        JOIN public.bargaining_cases bc ON bc.id = bt.bargaining_case_id
        WHERE bt.id = source_annotations.bargaining_term_id
          AND bt.is_published AND bt.verification_status = 'VERIFIED'
          AND bc.is_published AND bc.verification_status = 'VERIFIED'
          AND bc.include_in_primary_dashboard
          AND bc.scope_classification = 'PRIMARY_DIRECT_UNION'
          AND bc.covered_worker_relation = 'DIRECT'
      ))
    )
  );

-- 원문 URL은 공개된 주석으로 연결된 경우에만 anon에 노출된다.
-- 이 정책은 source_annotations 정책을 다시 참조하지 않으므로 순환 RLS 검사를 만들지 않는다.
CREATE POLICY anon_read_sources_linked_to_published_facts
  ON public.sources
  FOR SELECT TO anon
  USING (
    is_published
    AND verification_status = 'VERIFIED'
    AND EXISTS (
      SELECT 1
      FROM public.source_annotations sa
      WHERE sa.source_id = sources.id
        AND sa.is_published
        AND sa.verification_status = 'VERIFIED'
    )
  );

-- scope_review_audits와 company_add_requests에는 anon/authenticated 권한이나 정책을 만들지 않는다.
-- 따라서 서비스 역할 키를 가진 서버만 기록·검토할 수 있다.

COMMIT;
