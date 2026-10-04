import assert from 'node:assert/strict';
import test from 'node:test';
import { delayedTopic, extractArticleBody, employerBodyEvidence } from '../scripts/bargaining-evidence.mjs';
import { verifyPublisherPage } from '../scripts/resolve-google-news.mjs';

const employer = {id: 'a', aliases: ['한화오션']};
const rival = {id: 'b', aliases: ['HD현대중공업']};

test('the nearest action, not a surrounding bargaining noun, owns the delay', () => {
  assert.equal(delayedTopic('한화오션 교섭 요구안 제시가 지지부진').status, 'S1');
  assert.equal(delayedTopic('한화오션 본교섭이 지지부진').status, 'S3');
  assert.equal(delayedTopic('한화오션 공정이 지지부진'), null);
  assert.equal(delayedTopic('한화오션 본교섭이 지지부진하지 않다'), null);
  assert.equal(delayedTopic('지난해 요구안 제시가 지지부진했다'), null);
  assert.equal(delayedTopic('요구안 제시가 지지부진했지만 본교섭 결렬 선언'), null);
});

test('article extraction excludes surrounding related stories and scripts', () => {
  const body = extractArticleBody(`<div id="related">다른 기업 잠정합의</div>
    <div id="article-view-content-div"><p>한화오션 노사는</p>
    <div><p>실무교섭을 매일 진행하고 있다.</p></div><script>other()</script></div>
    <div id="comments">교섭 결렬</div>`);
  assert.match(body, /실무교섭/);
  assert.doesNotMatch(body, /다른 기업|other|교섭 결렬/);
  assert.equal(extractArticleBody('<main><p>잠정합의</p></main>'), '');
});

test('publisher page verification supplies body text on the actual network path', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    '<title>한화오션 교섭 지지부진</title><script type="application/ld+json">' +
    JSON.stringify({'@type': 'NewsArticle', articleBody: '한화오션 노사는 실무교섭을 매일 진행하고 있다.'}) + '</script>',
    {status: 200},
  ));
  const page = await verifyPublisherPage('https://example.com/article', '한화오션 교섭 지지부진');
  assert.equal(page.status, 'RESOLVED_AND_REACHABLE');
  const fact = employerBodyEvidence(page.articleBody, employer, [employer, rival]);
  assert.equal(fact.status, 'S3');
});

test('body scope does not cross a rival employer or a historical passage', () => {
  assert.equal(employerBodyEvidence('한화오션 현황\nHD현대중공업 현황\n노사는 본교섭이 지지부진하다.', employer, [employer, rival]), null);
  assert.equal(employerBodyEvidence('한화오션은 지난해 본교섭이 지지부진했다.', employer, [employer, rival]), null);
});
