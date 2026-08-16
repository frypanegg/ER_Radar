-- 주 단계에서 S8(이행·사후관리)을 없앤다.
--
-- S8은 협약이 체결된 뒤의 소급 지급·이행위원회·후속협의를 담으려던 좌표였다. 실제로
-- 쓰이지 않았고(공개 시드·경과 사건 어디에도 S8 기록이 없다), 화면에서는 누를 수 없는
-- 단계 버튼 하나로만 남아 있었다. 체결 이후의 이행은 좌표를 옮길 일이 아니라
-- agreement_state 오버레이(IMPLEMENTATION_FOLLOW_UP)로 표시하면 된다.
--
-- 이 마이그레이션은 CHECK 제약만 좁힌다. 데이터 이동이 없다 — 적용 전에 아래 확인문이
-- 0을 돌려주는지 보고, 그렇지 않으면 멈춘다. 남은 S8 행이 있는 상태로 제약을 좁히면
-- ALTER가 실패하므로, 조용히 깨지지 않고 그 자리에서 드러난다.

DO $$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*) INTO leftover FROM public.bargaining_cases WHERE primary_stage = 'S8';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'bargaining_cases에 S8 행이 %건 남아 있습니다. 단계를 옮긴 뒤 다시 실행하세요.', leftover;
  END IF;

  SELECT count(*) INTO leftover FROM public.bargaining_events WHERE stage_after = 'S8';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'bargaining_events에 S8 행이 %건 남아 있습니다. 단계를 옮긴 뒤 다시 실행하세요.', leftover;
  END IF;
END $$;

ALTER TABLE public.bargaining_cases
  DROP CONSTRAINT IF EXISTS bargaining_cases_primary_stage_check;
ALTER TABLE public.bargaining_cases
  ADD CONSTRAINT bargaining_cases_primary_stage_check
  CHECK (primary_stage IN ('U', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'));

ALTER TABLE public.bargaining_events
  DROP CONSTRAINT IF EXISTS bargaining_events_stage_after_check;
ALTER TABLE public.bargaining_events
  ADD CONSTRAINT bargaining_events_stage_after_check
  CHECK (stage_after IN ('U', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'));

-- case_status의 IMPLEMENTING은 그대로 둔다. S7 이후의 이행 국면을 사람이 손으로
-- 표시할 여지를 남기는 값이고, 단계 좌표와는 별개 축이다.
