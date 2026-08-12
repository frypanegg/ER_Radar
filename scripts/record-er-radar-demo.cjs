#!/usr/bin/env node

/**
 * 노사교섭 레이더 시연 영상 녹화 시나리오
 *
 * 화면 위에 타이틀·챕터·자막·합성 커서를 직접 주입하고, 실제 서비스의 검색·필터·
 * 과거 교섭 경과·근거 URL·기업 추가 기능을 조작한다. Playwright가 만든 WebM을
 * H.264 MP4로 변환하는 작업은 이 스크립트를 호출한 실행 명령에서 이어서 처리한다.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "artifacts");
const rawDir = path.join(outputDir, "_raw_capture");
const outputWebm = path.join(outputDir, "노사교섭_레이더_시연영상_원본.webm");
const outputMp4 = path.join(outputDir, "노사교섭_레이더_시연영상.mp4");
const targetUrl = process.env.ER_RADAR_URL || "https://er-radar.er-radar.workers.dev/";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpegPath = process.env.VIDEO_FFMPEG || path.join(
  projectRoot,
  ".video-runtime/python-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1",
);

fs.mkdirSync(rawDir, { recursive: true });
if (fs.existsSync(outputWebm)) fs.rmSync(outputWebm);

const timeScale = Number(process.env.DEMO_TIME_SCALE || "1");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(40, ms * timeScale)));

function installDemoOverlay() {
  const mount = () => {
    if (window.__erDemo || !document.body) return;

    const style = document.createElement("style");
    style.textContent = `
      #er-demo-root, #er-demo-root * { box-sizing: border-box; }
      #er-demo-root {
        position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
        font-family: Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
        color: #17333a;
      }
      #er-demo-cover {
        position: absolute; inset: 0; display: grid; place-items: center; opacity: 1;
        background:
          radial-gradient(circle at 14% 18%, rgba(105, 213, 203, .21), transparent 31%),
          radial-gradient(circle at 86% 74%, rgba(156, 187, 223, .20), transparent 34%),
          linear-gradient(135deg, #fbfdfd 0%, #eef8f6 47%, #edf3f9 100%);
        transition: opacity .65s ease;
        overflow: hidden;
      }
      #er-demo-cover::before, #er-demo-cover::after {
        content: ""; position: absolute; border-radius: 50%;
        border: 1px solid rgba(35, 147, 145, .15);
      }
      #er-demo-cover::before { width: 760px; height: 760px; right: -220px; top: -310px; }
      #er-demo-cover::after { width: 420px; height: 420px; right: -50px; top: -140px; }
      #er-demo-cover.is-hidden { opacity: 0; }
      #er-demo-cover-content { position: relative; width: min(1180px, 80vw); padding: 64px 70px; }
      #er-demo-kicker {
        display: inline-flex; align-items: center; min-height: 42px; padding: 0 18px;
        border: 1px solid rgba(18, 116, 116, .20); border-radius: 999px;
        background: linear-gradient(90deg, rgba(255,255,255,.78), rgba(227,247,244,.82));
        color: #247674; font-size: 20px; font-weight: 800; letter-spacing: .11em;
      }
      #er-demo-title { margin: 28px 0 20px; font-size: 74px; line-height: 1.15; letter-spacing: -.045em; }
      #er-demo-title b { color: #178b87; }
      #er-demo-sub { max-width: 980px; font-size: 31px; line-height: 1.55; color: #426169; font-weight: 620; }
      #er-demo-meta { margin-top: 34px; font-size: 22px; color: #6a858b; font-weight: 700; }
      #er-demo-dots { display: flex; gap: 10px; margin-top: 40px; }
      #er-demo-dots i { width: 34px; height: 6px; border-radius: 99px; background: rgba(27,116,115,.16); }
      #er-demo-dots i.on { background: linear-gradient(90deg, #35aaa4, #71c9c2); }
      #er-demo-chip {
        position: absolute; top: 34px; left: 42px; min-width: 182px; padding: 13px 20px;
        border: 1px solid rgba(38, 134, 131, .22); border-radius: 16px;
        background: linear-gradient(120deg, rgba(251,254,254,.94), rgba(227,247,244,.91));
        box-shadow: 0 12px 34px rgba(29,69,76,.14); color: #276b6c;
        font-size: 19px; font-weight: 800; letter-spacing: -.01em;
        opacity: 0; transform: translateY(-10px); transition: .35s ease;
      }
      #er-demo-chip.is-visible { opacity: 1; transform: translateY(0); }
      #er-demo-caption {
        position: absolute; left: 50%; bottom: 34px; width: min(1420px, calc(100vw - 100px));
        min-height: 94px; display: flex; align-items: center; padding: 20px 34px 20px 42px;
        border: 1px solid rgba(34, 126, 125, .20); border-radius: 20px;
        background: linear-gradient(100deg, rgba(253,254,254,.97), rgba(232,248,245,.95) 56%, rgba(237,244,251,.95));
        box-shadow: 0 18px 52px rgba(31,62,70,.18); backdrop-filter: blur(16px);
        color: #213d43; font-size: 28px; font-weight: 650; line-height: 1.48;
        opacity: 0; transform: translate(-50%, 18px); transition: .4s ease;
      }
      #er-demo-caption::before {
        content: ""; position: absolute; left: 19px; top: 22px; bottom: 22px; width: 5px;
        border-radius: 99px; background: linear-gradient(#2db3aa, #5f9fd2);
      }
      #er-demo-caption b { color: #0b817e; font-weight: 900; word-spacing: .08em; }
      #er-demo-caption.is-visible { opacity: 1; transform: translate(-50%, 0); }
      #er-demo-cursor {
        position: absolute; width: 24px; height: 24px; border-radius: 50%;
        border: 4px solid #fff; background: #14928e; box-shadow: 0 4px 18px rgba(10,80,81,.43);
        opacity: 0; transform: translate(-50%, -50%); transition: left .72s cubic-bezier(.22,.78,.2,1), top .72s cubic-bezier(.22,.78,.2,1), opacity .25s;
      }
      #er-demo-cursor.is-visible { opacity: 1; }
      #er-demo-click {
        position: absolute; width: 26px; height: 26px; border-radius: 50%;
        border: 3px solid rgba(17,148,142,.85); opacity: 0; transform: translate(-50%,-50%) scale(.4);
      }
      #er-demo-click.pulse { animation: er-click .62s ease-out; }
      @keyframes er-click { 0% { opacity: .9; transform: translate(-50%,-50%) scale(.35); } 100% { opacity: 0; transform: translate(-50%,-50%) scale(2.8); } }
    `;
    (document.head || document.documentElement).appendChild(style);

    const root = document.createElement("div");
    root.id = "er-demo-root";
    root.innerHTML = `
      <section id="er-demo-cover">
        <div id="er-demo-cover-content">
          <div id="er-demo-kicker"></div>
          <div id="er-demo-title"></div>
          <div id="er-demo-sub"></div>
          <div id="er-demo-meta"></div>
          <div id="er-demo-dots"></div>
        </div>
      </section>
      <div id="er-demo-chip"></div>
      <div id="er-demo-caption"></div>
      <div id="er-demo-click"></div>
      <div id="er-demo-cursor"></div>
    `;
    document.body.appendChild(root);

    const cover = root.querySelector("#er-demo-cover");
    const kicker = root.querySelector("#er-demo-kicker");
    const title = root.querySelector("#er-demo-title");
    const sub = root.querySelector("#er-demo-sub");
    const meta = root.querySelector("#er-demo-meta");
    const dots = root.querySelector("#er-demo-dots");
    const chip = root.querySelector("#er-demo-chip");
    const caption = root.querySelector("#er-demo-caption");
    const cursor = root.querySelector("#er-demo-cursor");
    const clickRing = root.querySelector("#er-demo-click");

    window.__erDemo = {
      cover(data) {
        chip.classList.remove("is-visible");
        caption.classList.remove("is-visible");
        cursor.classList.remove("is-visible");
        kicker.textContent = data.kicker || "PRODUCT DEMO";
        title.innerHTML = data.title || "";
        sub.innerHTML = data.sub || "";
        meta.textContent = data.meta || "";
        const total = data.total || 0;
        const current = data.current || 0;
        dots.innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < current ? "on" : ""}"></i>`).join("");
        cover.classList.remove("is-hidden");
      },
      coverOut() { cover.classList.add("is-hidden"); },
      say(html) {
        // 컬러 강조 태그 앞의 공백을 줄바꿈·HTML 공백 병합과 무관하게 보존한다.
        caption.innerHTML = html.replace(/\s+<b>/g, "&nbsp;<b>");
        caption.classList.add("is-visible");
      },
      sayOff() { caption.classList.remove("is-visible"); },
      chip(no, label) { chip.textContent = `${no} · ${label}`; chip.classList.add("is-visible"); },
      chipOff() { chip.classList.remove("is-visible"); },
      cursor(x, y) { cursor.style.left = `${x}px`; cursor.style.top = `${y}px`; cursor.classList.add("is-visible"); },
      cursorOff() { cursor.classList.remove("is-visible"); },
      click(x, y) {
        clickRing.style.left = `${x}px`; clickRing.style.top = `${y}px`;
        clickRing.classList.remove("pulse"); void clickRing.offsetWidth; clickRing.classList.add("pulse");
      }
    };
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome 실행 파일을 찾을 수 없습니다: ${chromePath}`);

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: rawDir, size: { width: 1600, height: 900 } },
    colorScheme: "light",
    locale: "ko-KR",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const video = page.video();

  await page.addInitScript({ content: `(${installDemoOverlay.toString()})()` });
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__erDemo));

  const overlay = async (method, ...args) => {
    await page.evaluate(({ method, args }) => window.__erDemo[method](...args), { method, args });
  };
  const say = async (html, ms = 6200) => { await overlay("say", html); await wait(ms); };
  const sayOff = async () => { await overlay("sayOff"); await wait(420); };
  const scrollTo = async (locator, topPadding = 110) => {
    await locator.first().evaluate((element, padding) => {
      const y = element.getBoundingClientRect().top + window.scrollY - padding;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }, topPadding);
    await wait(1200);
  };
  const point = async (locator) => {
    const box = await locator.first().boundingBox();
    if (!box) return null;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await overlay("cursor", x, y);
    await wait(820);
    return { x, y };
  };
  const click = async (locator) => {
    const p = await point(locator);
    if (p) await overlay("click", p.x, p.y);
    await wait(260);
    await locator.first().click();
    await wait(900);
  };
  const chapter = async (current, title, subTitle) => {
    await overlay("cover", {
      kicker: `CHAPTER ${String(current).padStart(2, "0")}`,
      title,
      sub: subTitle,
      meta: `${current} / 7`,
      current,
      total: 7,
    });
    await wait(4200);
    await overlay("coverOut");
    await wait(900);
    await overlay("chip", String(current).padStart(2, "0"), title.replace(/<[^>]+>/g, ""));
  };

  // 오프닝
  await overlay("cover", {
    kicker: "PRODUCT DEMO",
    title: "노사교섭 <b>레이더</b>",
    sub: "대한민국 주요 제조업의 임금협상·단체교섭 현황을<br>기사 원문과 교섭 단계로 읽는 대시보드",
    meta: "12개사 · 2021–2026 · 매일 1회 갱신",
    current: 0,
    total: 7,
  });
  await wait(6200);
  await overlay("coverOut");
  await wait(1300);
  await say("뉴스를 날짜순으로 쌓는 대신, 각 기업의 교섭을 <b>현재 단계</b>로 정리합니다.", 6200);
  await say("하청·사내협력사 교섭은 분리하고, <b>원청 노동조합</b>으로 확인된 기록만 보여줍니다.", 7000);
  await sayOff();

  // 1. 현재 현황
  await chapter(1, "현재 교섭 좌표", "2026년 주요 기업의 상태를 한 화면에서 확인합니다.");
  await scrollTo(page.locator("#board"), 80);
  await say("기준일·검증 건수와 함께 <b>12개 기업의 2026년 교섭 단계</b>가 먼저 보입니다.", 6600);
  const hyundai2026 = page.getByRole("button", { name: /2026년.*현대자동차/ });
  await point(hyundai2026);
  await say("기업 카드에는 협상 유형, 노동조합, 현재 주 단계와 <b>마지막 검증일</b>을 함께 표시합니다.", 7000);
  await click(hyundai2026);
  await say("카드를 선택하면 오른쪽 상세 정보가 같은 화면에서 즉시 바뀝니다.", 5500);
  await sayOff();

  // 2. 회사 검색
  await chapter(2, "회사명 검색", "궁금한 회사의 기록만 빠르게 좁혀봅니다.");
  await scrollTo(page.getByRole("searchbox", { name: "원청 노조 확정 법인 검색" }), 230);
  const searchbox = page.getByRole("searchbox", { name: "원청 노조 확정 법인 검색" });
  await point(searchbox);
  await searchbox.fill("삼성전자");
  await wait(1000);
  await say("회사명을 입력하면 해당 법인의 <b>검증된 원청 노조 교섭</b>만 남습니다.", 6500);
  const samsung2026 = page.getByRole("button", { name: /2026년.*삼성전자/ });
  await click(samsung2026);
  await say("삼성전자는 2026년 임금협상과 체결 단계, 검증일을 한 번에 확인할 수 있습니다.", 6700);
  await searchbox.fill("");
  await wait(900);
  await say("검색어를 지우면 전체 기업 목록으로 바로 돌아옵니다.", 5200);
  await sayOff();

  // 3. 단계별 조회
  await chapter(3, "교섭 단계별 조회", "시기가 다른 기업도 같은 상태 좌표에서 비교합니다.");
  await scrollTo(page.getByRole("tab", { name: "S4 교착·조정" }), 280);
  const stageS4 = page.getByRole("tab", { name: "S4 교착·조정" });
  await click(stageS4);
  await say("S4를 누르면 교착·결렬·노동위원회 조정 경로에 있는 기업만 모입니다.", 6600);
  await say("이 단계는 완료율이 아니라 <b>가장 최근의 고신뢰 발생 사실</b>을 뜻합니다.", 6700);
  const s4First = page.getByRole("list", { name: "검증된 교섭현황 목록" }).getByRole("button").first();
  await click(s4First);
  await scrollTo(page.getByRole("heading", { name: "교착·조정 경로" }), 135);
  await say("상세 화면에서는 현재 국면과 함께 쟁점, 쟁의 수준, 다음 확인 포인트를 읽습니다.", 7200);
  await sayOff();
  await click(page.getByRole("tab", { name: "전체", exact: true }));

  // 4. 과거 교섭 경과
  await chapter(4, "과거 교섭 경과", "타결일만이 아니라 교섭의 흐름을 연도별로 봅니다.");
  await scrollTo(page.getByRole("tab", { name: "2025년" }), 250);
  await click(page.getByRole("tab", { name: "2025년" }));
  await say("2021년부터 2025년까지 같은 회사의 과거 교섭 기록을 조회할 수 있습니다.", 6500);
  const hyundai2025 = page.getByRole("button", { name: /2025년.*현대자동차/ });
  await click(hyundai2025);
  await scrollTo(page.getByRole("region", { name: "교섭 경과" }), 110);
  await say("현대자동차의 2025년 기록은 <b>교섭 개시 → 잠정합의 → 찬반투표</b>의 순서를 보여줍니다.", 7600);
  await say("각 단계에는 날짜·핵심 경과·원문 링크가 연결되어 과거 흐름을 다시 확인할 수 있습니다.", 7200);
  await sayOff();

  // 5. 근거와 원청 범위
  await chapter(5, "근거가 남는 기록", "요약 뒤에는 기사 원문과 범위 판정 근거가 있습니다.");
  await scrollTo(page.getByRole("region", { name: "원문 URL 주석" }), 120);
  await say("모든 주요 상태에는 기사 제목·매체·검증일과 <b>실제 원문 URL</b>을 주석으로 남깁니다.", 7200);
  await point(page.getByRole("link", { name: /edaily\.co\.kr/ }));
  await say("사용자는 요약을 읽은 뒤, 필요할 때 원문으로 이동해 판단 근거를 직접 확인할 수 있습니다.", 7200);
  await scrollTo(page.getByRole("note"), 150);
  await say("원청 법인 직접고용 노조만 본 화면에 포함하고, 하청·용역·파견 사례는 별도로 검토합니다.", 7600);
  await sayOff();

  // 6. 일일 수집
  await chapter(6, "매일 한 번 갱신", "새 기사에서 확인된 사실만 안전하게 상태에 반영합니다.");
  await scrollTo(page.locator("#collection"), 70);
  await say("매일 오전 6시 30분, 법인별 한 번씩 뉴스 후보를 수집하도록 설계했습니다.", 6400);
  await point(page.getByText("매일 06:30 KST", { exact: true }));
  await say("후보 수집 → 사실 정규화 → 근거 등급 판정 → 상태 반영의 <b>4단계 검증</b>을 거칩니다.", 7200);
  await scrollTo(page.getByRole("heading", { name: "상태 안전 반영" }), 470);
  await say("새 기사가 없거나 검증에 실패하면, 이전 확정 상태를 임의로 바꾸지 않습니다.", 6600);
  await sayOff();

  // 7. 추적 기업 추가
  await chapter(7, "추적 기업 확장", "새 회사를 같은 프레임으로 추가할 수 있습니다.");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await wait(1400);
  const addButton = page.getByRole("button", { name: "추적 기업 추가" }).first();
  await click(addButton);
  await say("추가하려는 법인의 실명·산업 분야·참고 근거를 입력해 검토를 요청합니다.", 6500);
  await page.getByRole("textbox", { name: "법인 실명 필수" }).fill("에이치엘만도 주식회사");
  await wait(700);
  await page.getByRole("textbox", { name: "산업 분야" }).fill("자동차부품");
  await wait(700);
  await page.getByRole("textbox", { name: "참고 URL" }).fill("https://www.hlmando.com/");
  await wait(700);
  await page.getByRole("textbox", { name: "추가 사유" }).fill("산업 영향도와 원청 노조 교섭 노출도가 높은 기업");
  await wait(900);
  await say("승인된 회사는 기존 12개사와 동일하게 <b>과거 연도 데이터와 현재 단계</b>를 축적할 수 있습니다.", 7600);
  await say("이 시연에서는 요청을 전송하지 않고, 입력 화면과 확장 방식만 확인합니다.", 5700);
  await click(page.getByRole("button", { name: "취소" }));
  await sayOff();

  // 클로징
  await overlay("chipOff");
  await overlay("cursorOff");
  await overlay("cover", {
    kicker: "ER RADAR",
    title: "교섭의 변화, <b>근거로 읽다.</b>",
    sub: "원청 노조의 현재 상태와 과거 흐름을 한눈에",
    meta: "노사교섭 레이더 · 2026.08",
    current: 7,
    total: 7,
  });
  await wait(7200);

  await page.close();
  await context.close();
  await browser.close();

  const recordedPath = await video.path();
  fs.copyFileSync(recordedPath, outputWebm);
  fs.rmSync(rawDir, { recursive: true, force: true });

  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(`MP4 변환용 ffmpeg를 찾을 수 없습니다. VIDEO_FFMPEG 환경변수로 경로를 지정하세요: ${ffmpegPath}`);
  }
  const conversion = spawnSync(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", outputWebm,
    "-vf", "setpts=0.95*PTS,scale=1920:1080:flags=lanczos",
    "-r", "30",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    outputMp4,
  ], { stdio: "inherit" });
  if (conversion.status !== 0) throw new Error(`MP4 변환 실패: 종료 코드 ${conversion.status}`);

  fs.rmSync(outputWebm, { force: true });
  process.stdout.write(`${outputMp4}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
