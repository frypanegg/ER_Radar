#!/usr/bin/env node
/**
 * 접수 즉시 나가는 관리자 인증 메일을 만든다.
 *
 * 아침 보고 메일은 하루에 한 번이라, 오후에 들어온 요청은 다음 날 아침까지 아무도 모른다.
 * 화면에서 운영 관리 코드를 없앤 뒤로는 이 메일이 유일한 관문이므로 접수 즉시 보낸다.
 *
 * 본문에는 신청자와 무엇을 요청했는지만 담는다. 요청 본문과 근거는 인증 링크를 열어야
 * 보이고, 링크를 여는 것만으로는 DB가 바뀌지 않는다. 승인은 POST에서만 일어난다.
 */
import { writeFile } from "node:fs/promises";

import {
  buildHtmlReport,
  buildMimeMessage,
  createSignedReviewUrl,
} from "./build-daily-report.mjs";

function readArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    options[key.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }
  return options;
}

export function buildRequestNotice({ kind, requestId, subject, requester, requesterEmail, reviewUrl }) {
  const label = kind === "correction" ? "데이터 수정 요청" : "추적 기업 추가 요청";
  const lines = [
    `■ ${label}이 접수됐습니다.`,
    "",
    `  대상: ${subject || "(미기재)"}`,
    `  신청자: ${requester || "(미기재)"}`,
    `  회신 이메일: ${requesterEmail || "(미기재)"}`,
    `  접수 번호: ${requestId}`,
    "",
    "  아래 인증 버튼을 눌러 내용을 확인한 뒤 승인 또는 반려합니다.",
    "  링크를 여는 것만으로는 공개 데이터가 바뀌지 않습니다. 승인해야 반영됩니다.",
    "",
    "신청자 정보는 인증 수단이 아니라 연락처입니다. 요청 내용이 근거와 맞는지는 링크에서 확인하세요.",
  ];
  return {
    subject: `[노사교섭 레이더] ${label} 인증 요청 · ${subject || requestId}`,
    text: lines.join("\n"),
    pendingReviews: [{ kind, label: `${label} · ${subject || requestId}`, reviewUrl }],
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const secret = process.env.DASHBOARD_ADMIN_CODE;
  if (!secret) throw new Error("DASHBOARD_ADMIN_CODE가 없어 인증 링크를 만들 수 없습니다.");
  if (!options.kind || !options["request-id"]) throw new Error("--kind와 --request-id가 필요합니다.");

  const expires = Math.floor(Date.now() / 1000) + 48 * 60 * 60;
  const reviewUrl = createSignedReviewUrl({
    siteUrl: options["site-url"] ?? "https://er-radar.er-radar.workers.dev/",
    secret,
    kind: options.kind,
    id: options["request-id"],
    expires,
  });

  const notice = buildRequestNotice({
    kind: options.kind,
    requestId: options["request-id"],
    subject: options.subject,
    requester: options.requester,
    requesterEmail: options["requester-email"],
    reviewUrl,
  });

  const message = buildMimeMessage({
    from: options.from,
    to: options.to,
    subject: notice.subject,
    text: notice.text,
    html: buildHtmlReport({ text: notice.text, pendingReviews: notice.pendingReviews }),
  });

  await writeFile(options.out ?? "tmp/request-notice.eml", message, "utf8");
  console.log(`인증 요청 메일을 만들었습니다: ${options.out}`);
}

if (process.argv[1] && process.argv[1].endsWith("build-request-notice.mjs")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
