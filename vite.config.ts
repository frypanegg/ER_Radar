import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// Worker 이름이 배포 URL의 서브도메인이 된다: er-radar.<계정>.workers.dev
const localBindingConfig = {
  name: "er-radar",
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  // worker/index.ts가 env.ASSETS로 정적 파일을 읽는다. 바인딩 이름을 선언하지 않으면
  // 배포본에서 env.ASSETS가 undefined가 된다.
  assets: { binding: "ASSETS" },
  // 공개 주소는 workers.dev 하나로 묶는다. 버전별 Preview URL은 같은 화면을 가리키는
  // 공개 주소를 매 배포마다 하나씩 더 만들 뿐이어서, 검색 비노출·URL 유출 최소화
  // 정책(docs/공유-접근과-검색비노출-정책.md)과 맞지 않는다.
  workers_dev: true,
  preview_urls: false,
  // 일일 수집을 깨우는 발사대. GitHub의 schedule 이벤트가 나흘 연속 정시에 발화하지
  // 않아(2026-08-10~13, 그중 이틀은 세 슬롯 전부 누락) 발사대를 여기로 옮겼다.
  // worker/index.ts의 scheduled()가 GitHub workflow_dispatch를 호출한다.
  //
  // 06:20 KST = 21:20 UTC. GitHub cron(06:34 KST)보다 앞에 두어 정상적인 날에는
  // 이쪽이 먼저 깨우고, GitHub 쪽은 이중화로 남는다. 중복은 워크플로 가드가 막는다.
  triggers: { crons: ["20 21 * * *"] },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
