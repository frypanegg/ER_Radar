// 시드에서 사라진 공개 교섭 사건을 Supabase에서 지운다.
//
// load-supabase-seed.mjs의 업서트 충돌 대상은
// company_id,bargaining_year,agreement_type,bargaining_unit_key,covered_worker_scope_key
// 다. agreement_type이 자연키에 들어 있어서, 협약유형을 정정하면 기존 행이 수정되는 게
// 아니라 새 행이 하나 더 생긴다. 실제로 포스코 2026년을 INTEGRATED에서 WAGE로 고쳤더니
// 두 행이 공존했고, 화면은 옛 행을 집어 계속 통합 임단협을 보여줬다.
//
// 자연키에 agreement_type이 있는 것 자체는 맞다. 한 해에 임금교섭과 단체교섭이 별개
// 사건으로 서는 회사가 있기 때문이다. 그래서 키를 바꾸는 대신, 시드에 없는 공개 행을
// 걷어내는 단계를 따로 둔다.
//
//  - --dry-run은 지울 대상만 보여주고 아무것도 바꾸지 않는다.
//  - 시드가 다루는 (법인, 연도) 조합 안에서만 지운다. 시드가 관리하지 않는 해의 기록을
//    이 스크립트가 건드리는 일은 없어야 한다.
//  - bargaining_events·issues·terms는 ON DELETE CASCADE라 함께 정리된다.

import { readFile } from "node:fs/promises";

import { buildCaseRow, publishableRecords } from "./load-supabase-seed.mjs";

const root = new URL("../", import.meta.url);

function requireEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`환경변수가 필요합니다: ${names.join(" 또는 ")}`);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

async function getRows(baseUrl, key, path) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`조회 실패 (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

/** 업서트 충돌 대상과 같은 순서·같은 값으로 자연키를 만든다. */
function naturalKey(row) {
  return [
    row.company_id,
    row.bargaining_year,
    row.agreement_type,
    row.bargaining_unit_key,
    row.covered_worker_scope_key,
  ].join("|");
}

export function findOrphans(seedRows, dbRows) {
  const seedKeys = new Set(seedRows.map(naturalKey));
  // 시드가 실제로 다루는 범위. 이 밖의 행은 판단 근거가 없으므로 손대지 않는다.
  const managedScopes = new Set(
    seedRows.map((row) => `${row.company_id}|${row.bargaining_year}`),
  );
  return dbRows.filter(
    (row) =>
      managedScopes.has(`${row.company_id}|${row.bargaining_year}`) &&
      !seedKeys.has(naturalKey(row)),
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const baseUrl = requireEnv(["SUPABASE_URL", "SUPABASE_PJT_URL", "SUPABASE_PROJECT_URL"]);
  const key = requireEnv(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"]);

  const [historical, current, universe] = await Promise.all([
    readJson("data/historical-fact-seed.json"),
    readJson("data/current-2026-fact-seed.json"),
    readJson("data/company-universe.json"),
  ]);
  const records = publishableRecords([...historical.records, ...current.records]);

  const companies = await getRows(baseUrl, key, "tracked_companies?select=id,slug,legal_name");
  const companyIdBySlug = new Map(companies.map((row) => [row.slug, row.id]));
  const companyNameById = new Map(companies.map((row) => [row.id, row.legal_name]));
  const trackedSlugs = new Set(
    (universe.initialPublicTracking ?? []).map((company) => company.id),
  );
  for (const slug of trackedSlugs) {
    if (!companyIdBySlug.has(slug)) {
      throw new Error(`DB에 없는 추적 법인입니다: ${slug}`);
    }
  }

  const seedRows = records.map((record) => buildCaseRow(record, companyIdBySlug));
  const dbRows = await getRows(
    baseUrl,
    key,
    "bargaining_cases?select=id,company_id,bargaining_year,agreement_type,bargaining_unit_key,covered_worker_scope_key,is_published&is_published=eq.true",
  );

  const orphans = findOrphans(seedRows, dbRows);
  console.log(`시드 공개 사건 ${seedRows.length}건 · DB 공개 사건 ${dbRows.length}건`);

  if (orphans.length === 0) {
    console.log("시드에 없는 공개 사건이 없습니다. 지울 것이 없습니다.");
    return;
  }

  console.log(`시드에 없는 공개 사건 ${orphans.length}건:`);
  for (const row of orphans) {
    const name = companyNameById.get(row.company_id) ?? row.company_id;
    console.log(`  ${name} ${row.bargaining_year} ${row.agreement_type} (${row.id})`);
  }

  if (dryRun) {
    console.log("--dry-run이라 지우지 않았습니다.");
    return;
  }

  for (const row of orphans) {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/rest/v1/bargaining_cases?id=eq.${row.id}`,
      {
        method: "DELETE",
        headers: { apikey: key, authorization: `Bearer ${key}`, prefer: "return=minimal" },
      },
    );
    if (!response.ok) {
      throw new Error(
        `삭제 실패 ${row.id} (${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }
  }
  console.log(`${orphans.length}건을 지웠습니다.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
