// Extract employer-bound evidence before assigning a bargaining stage.
// A delay describes its grammatical topic; it is never a stage on its own.
const DELAY = /지지부진|더디|지연|난항|장기화|답보/u;
const TOPICS = [
  { topic: 'ratification', stage: 'tentative_agreement', status: 'S6', re: /(?:잠정\s*합의안?\s*)?(?:인준|찬반\s*투표|조합원\s*투표)(?:\s*(?:절차|진행))?/gu },
  { topic: 'signature', stage: 'tentative_agreement', status: 'S6', re: /(?:협약\s*)?(?:조인식|서명|체결)(?:\s*(?:절차|진행))?/gu },
  { topic: 'representation', stage: 'preparation', status: 'S2', re: /교섭\s*창구\s*단일화|교섭\s*대표(?:노조)?\s*(?:선정|확정|결정)/gu },
  { topic: 'demand_preparation', stage: 'preparation', status: 'S1', re: /(?:교섭\s*)?(?:요구안|요구사항|제시안)\s*(?:작성|준비|수렴|마련|확정|제시|제출|전달)/gu },
  { topic: 'bargaining_opening', stage: 'preparation', status: 'S1', re: /(?:본교섭|교섭|협상)\s*(?:개시|시작)|상견례/gu },
  { topic: 'agreement_formation', stage: 'bargaining', status: 'S3', re: /잠정\s*합의(?:안)?\s*(?:도출|마련|성립)/gu },
  { topic: 'ongoing_bargaining', stage: 'bargaining', status: 'S3', re: /본교섭|실무교섭|임금\s*협상|단체\s*교섭|교섭|협상/gu },
];

export function delayedTopic(text) {
  const delayed = [];
  for (const rule of TOPICS) {
    for (const match of text.matchAll(rule.re)) {
      const after = text.slice(match.index + match[0].length);
      // Only case particles/adverbs can connect this topic to the delay.
      // Thus "교섭 요구안 제시가 지지부진" binds to "요구안 제시", not "교섭".
      const predicate = after.match(/^(?:은|는|이|가|도|의)?\s*(?:(?:계속|여전히|좀처럼|아직|다소)\s*)?(지지부진|더디|지연|난항|장기화|답보)/u);
      if (predicate && !/^(?:하지?\s*않|이?\s*아니|될\s*(?:경우|전망)|할\s*경우)/u.test(after.slice(predicate[0].length))) delayed.push({ ...rule, index: match.index, text: match[0] + predicate[0] });
    }
  }
  if (delayed.length !== 1) return null;
  const { re, ...fact } = delayed[0];
  const remainder = text.replace(fact.text, "");
  // A completed later event supersedes a description of an earlier delay.
  if (/지난해|작년|당시/u.test(text) ||
      /(?:본교섭|교섭|협상).{0,8}(?:개시|시작|결렬|재개)|조정\s*신청|잠정\s*합의(?:안)?.{0,5}(?:도출|마련|가결)|협약.{0,5}(?:서명|체결)/u.test(remainder)) return null;
  return fact;
}

const compact = (value) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const mentions = (text, company) => employerAliases(company).some((alias) => compact(text).includes(compact(alias)));

export function employerBodyEvidence(body, company, companies) {
  if (!body || !company) return null;
  // Resolve only explicit employer subjects and their immediately following
  // anaphoric sentences. Another employer or a historical paragraph ends scope.
  const sentences = body.split(/\n+|(?<=[다요])\.\s*/u).map((s) => s.trim()).filter(Boolean);
  let active = false;
  let scopeContext = "";
  const owned = [];
  for (const sentence of sentences) {
    const named = companies.filter((c) => mentions(sentence, c));
    const target = mentions(sentence, company);
    const foreign = named.some((c) => c.id !== company.id);
    if (foreign || /지난해|작년|당시/u.test(sentence)) { active = false; continue; }
    if (target) { active = true; scopeContext = sentence; }
    else if (!/^(?:노사|노조|회사\s*측|사측|다만\s*노사|\d{1,2}일\s*교섭|협상)/u.test(sentence)) active = false;
    if (active) {
      if (/^(?:노사|노조|다만\s*노사)/u.test(sentence)) scopeContext += ` ${sentence}`;
      owned.push({ sentence, scopeContext });
    }
  }
  // Prefer an explicit current activity over commentary such as "지지부진".
  for (const { sentence, scopeContext } of owned) {
    const delay = delayedTopic(sentence);
    if (delay) return { ...delay, text: sentence, scopeContext, basis: 'publisher_body_subject_predicate' };
    if (/(?:본교섭|실무교섭|교섭|협상).{0,35}(?:진행하|진행\s*중|이어가|들어갔|매일\s*(?:실시|진행)|계속하고)/u.test(sentence) &&
        !/(?:예정|전망|검토|가능성)/u.test(sentence)) {
      return { text: sentence, scopeContext, topic: 'ongoing_bargaining', stage: 'bargaining', status: 'S3', basis: 'publisher_body_subject_predicate' };
    }
  }
  return null;
}

export function needsBodyEvidence(text) {
  return (DELAY.test(text) && !delayedTopic(text)) || /농성|파업|쟁의|갈등|교섭.*남/u.test(text);
}

// Read only identified article containers or Article JSON-LD, not navigation,
// related stories or comments. The full text remains transient, never published.
export function extractArticleBody(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const visit = (value) => {
        if (!value || typeof value !== 'object') return null;
        if (typeof value.articleBody === 'string') return value.articleBody;
        for (const child of Object.values(value)) {
          const result = visit(child);
          if (result) return result;
        }
        return null;
      };
      const body = visit(JSON.parse(match[1]));
      if (body) return body.slice(0, 60000);
    } catch { /* Fall back to a known article container. */ }
  }
  const opening = /<(div|section)\b[^>]*\b(?:id|class)=["'](?:article-view-content-div|articleBodyContents|articleBody|newsct_article|dic_area|news-contents)["'][^>]*>/i.exec(html);
  if (!opening) return '';
  const start = opening.index + opening[0].length;
  const tags = new RegExp(`<\\/?${opening[1]}\\b[^>]*>`, 'gi');
  tags.lastIndex = start;
  let depth = 1, end = start;
  for (let match; (match = tags.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { end = match.index; break; }
  }
  return html.slice(start, end)
    .replace(/<(script|style|figure)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .slice(0, 60000).trim();
}

export function employerAliases(company) {
  return [...new Set(company.aliases.flatMap((alias) =>
    alias.endsWith('중공업') ? [alias, alias.replace(/중공업$/u, '重')] : [alias],
  ))];
}

export function employerHeadline(title, company, companies) {
  if (!company) return { text: title, multipleEmployers: false };
  const found = [];
  for (const entry of companies) {
    for (const alias of employerAliases(entry)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped.replace(/\s+/g, '\\s*'), 'giu');
      for (const match of title.matchAll(pattern)) {
        const after = title.slice(match.index + match[0].length);
        if (!/^(?:$|[\s\p{P}\p{S}]|[은는이가도와과만](?:$|[\s\p{P}\p{S}])|노사|노조|임단협)/u.test(after)) continue;
        found.push({ id: entry.id, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  // Also recognize newspaper abbreviations for employers outside our registry.
  // They define a subject boundary but are never assigned a tracked employer ID.
  for (const match of title.matchAll(/[A-Z\p{Script=Hangul}]{1,12}重/gu)) {
    found.push({ id: `untracked:${match[0]}`, start: match.index, end: match.index + match[0].length });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || Number(a.id.startsWith('untracked:')) - Number(b.id.startsWith('untracked:')));
  const mentions = [];
  for (const match of found) {
    if (!mentions.length || match.start >= mentions.at(-1).end) mentions.push(match);
  }
  const multipleEmployers = new Set(mentions.map((m) => m.id)).size > 1;
  if (!multipleEmployers) return { text: title, multipleEmployers: false };
  const parts = mentions.flatMap((mention, index) => mention.id === company.id
    ? [title.slice(mention.start, mentions[index + 1]?.start ?? title.length)
        .replace(/[\s·ㆍ,;…]+$/gu, '').replace(/\.{2,}$/u, '')]
    : []);
  return { text: parts.join(' … '), multipleEmployers };
}
