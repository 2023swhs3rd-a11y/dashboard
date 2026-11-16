// GitHub API에서 repo 통계를 모아 data/dashboard.json에 저장합니다.
// 필요한 환경 변수: GH_TOKEN (traffic 조회 권한이 있는 토큰)
import fs from 'node:fs/promises';

const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN이 없습니다. repo의 Settings → Secrets에 DASHBOARD_TOKEN을 등록하세요.');
  process.exit(1);
}
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const OUT = 'data/dashboard.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (iso) => String(iso).slice(0, 10);

// 결과: { ok: true, value } | { ok: false, missing: true } (404) | { ok: false } (준비 안 됨·실패)
async function gh(path, { retries = 0 } = {}) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(API + path, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'repo-dashboard-collector',
        },
      });
    } catch (e) {
      console.warn(`  ! ${path}: ${e.message}`);
      return { ok: false };
    }
    if (res.status === 202 && i < retries) { await sleep(4000); continue; }
    if (res.status === 202) return { ok: false };           // 통계 계산 중: 다음 실행에서 채워짐
    if (res.status === 204) return { ok: true, value: [] }; // 내용 없음 (빈 repo 등)
    if (res.status === 404) return { ok: false, missing: true };
    if (!res.ok) {
      console.warn(`  ! ${path}: HTTP ${res.status}`);
      return { ok: false };
    }
    return { ok: true, value: await res.json() };
  }
}

let prev = {};
try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* 첫 실행 */ }
const prevRows = (name, repo) => (prev[name] || []).filter((r) => r.repo === repo);

// 1. repo 목록
const all = [];
for (let page = 1; page < 20; page++) {
  const r = await gh(`/user/repos?affiliation=owner&per_page=100&page=${page}`);
  if (!r.ok) { console.error('repo 목록을 가져오지 못했습니다. 토큰을 확인하세요.'); process.exit(1); }
  all.push(...r.value);
  if (r.value.length < 100) break;
}
const exclude = new Set(cfg.exclude || []);
const list = all.filter((r) =>
  r.owner.login.toLowerCase() === cfg.owner.toLowerCase() &&
  !exclude.has(r.name) &&
  (cfg.includePrivate || !r.private) &&
  (cfg.includeForks !== false || !r.fork) &&
  !r.archived);
console.log(`대상 repo ${list.length}개`);

const out = { generated_at: new Date().toISOString(), owner: cfg.owner, repos: [], traffic: [], commits: [], codefreq: [], punchcard: [], referrers: [], actions: [], languages: [] };
const since14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
const trafficMap = new Map((prev.traffic || []).map((r) => [r.date + '|' + r.repo, r]));

for (const r of list) {
  const repo = r.name, base = `/repos/${r.full_name}`;
  console.log(`- ${repo}`);

  // Pages 상태
  let pagesStatus = 'none', pagesUrl = '';
  if (r.has_pages) {
    const p = await gh(`${base}/pages`);
    if (p.ok) { pagesStatus = p.value.status || 'built'; pagesUrl = p.value.html_url || ''; }
    else pagesStatus = (prev.repos || []).find((x) => x.repo === repo)?.pages_status || 'unknown';
  }
  out.repos.push({
    repo, url: r.html_url, visibility: r.private ? 'private' : 'public',
    kind: r.fork ? '포크' : r.has_pages ? 'Pages 사이트' : '저장소',
    language: r.language || '', stars: r.stargazers_count, forks: r.forks_count,
    open_issues: r.open_issues_count, size_kb: r.size, last_push: day(r.pushed_at), pushed_at: r.pushed_at,
    pages_status: pagesStatus, pages_url: pagesUrl,
  });

  // 방문·클론 (최근 14일, 이전 기록과 합침)
  const [views, clones] = await Promise.all([gh(`${base}/traffic/views`), gh(`${base}/traffic/clones`)]);
  // GitHub이 주는 14일 합계. 순 방문자는 여러 날 온 사람을 한 번만 셉니다.
  const rec = out.repos[out.repos.length - 1];
  const before = (prev.repos || []).find((x) => x.repo === repo) || {};
  rec.views14 = views.ok ? views.value.count ?? null : before.views14 ?? null;
  rec.uniques14 = views.ok ? views.value.uniques ?? null : before.uniques14 ?? null;
  rec.clones14 = clones.ok ? clones.value.count ?? null : before.clones14 ?? null;
  rec.clone_uniques14 = clones.ok ? clones.value.uniques ?? null : before.clone_uniques14 ?? null;
  if (views.ok) for (const v of views.value.views || []) {
    const k = day(v.timestamp) + '|' + repo;
    trafficMap.set(k, { ...(trafficMap.get(k) || { clones: 0 }), date: day(v.timestamp), repo, views: v.count, uniques: v.uniques });
  }
  if (clones.ok) for (const c of clones.value.clones || []) {
    const k = day(c.timestamp) + '|' + repo;
    trafficMap.set(k, { views: 0, uniques: 0, ...(trafficMap.get(k) || {}), date: day(c.timestamp), repo, clones: c.count });
  }

  // 유입 경로 (최근 14일 합계)
  const refs = await gh(`${base}/traffic/popular/referrers`);
  out.referrers.push(...(refs.ok ? refs.value.map((x) => ({ repo, referrer: x.referrer, views: x.count, uniques: x.uniques })) : prevRows('referrers', repo)));

  // 커밋 통계 (처음에는 계산 중일 수 있어 몇 번 다시 시도)
  const [ca, cf, pc] = await Promise.all([
    gh(`${base}/stats/commit_activity`, { retries: 3 }),
    gh(`${base}/stats/code_frequency`, { retries: 3 }),
    gh(`${base}/stats/punch_card`, { retries: 3 }),
  ]);
  if (ca.ok && Array.isArray(ca.value)) {
    for (const w of ca.value) w.days.forEach((n, i) => {
      out.commits.push({ date: new Date((w.week + i * 86400) * 1000).toISOString().slice(0, 10), repo, commits: n });
    });
  } else out.commits.push(...prevRows('commits', repo));
  if (cf.ok && Array.isArray(cf.value)) {
    for (const [wk, add, del] of cf.value.slice(-53)) out.codefreq.push({ week: new Date(wk * 1000).toISOString().slice(0, 10), repo, additions: add, deletions: Math.abs(del) });
  } else out.codefreq.push(...prevRows('codefreq', repo));
  if (pc.ok && Array.isArray(pc.value)) {
    for (const [wd, hour, n] of pc.value) if (n) out.punchcard.push({ repo, weekday: wd, hour, commits: n });
  } else out.punchcard.push(...prevRows('punchcard', repo));

  // 언어
  const lang = await gh(`${base}/languages`);
  out.languages.push(...(lang.ok ? Object.entries(lang.value).map(([language, bytes]) => ({ repo, language, bytes })) : prevRows('languages', repo)));

  // Actions 실행 (최근 14일, 끝난 것만)
  const runs = await gh(`${base}/actions/runs?per_page=100&created=${encodeURIComponent('>=' + since14)}`);
  if (runs.ok) {
    for (const w of runs.value.workflow_runs || []) {
      if (w.status !== 'completed') continue;
      out.actions.push({
        run_id: w.id, repo, workflow: w.name || '', conclusion: w.conclusion || '', started_at: w.run_started_at || w.created_at,
        duration_sec: Math.max(0, Math.round((Date.parse(w.updated_at) - Date.parse(w.run_started_at || w.created_at)) / 1000)), url: w.html_url,
      });
    }
  } else if (!runs.missing) out.actions.push(...prevRows('actions', repo));
}

// 방문 기록: 대상 repo만, 보존 기간 안의 것만
const names = new Set(list.map((r) => r.name));
const cutoff = new Date(Date.now() - (cfg.trafficHistoryDays || 400) * 86400000).toISOString().slice(0, 10);
out.traffic = [...trafficMap.values()]
  .filter((r) => names.has(r.repo) && r.date >= cutoff)
  .map((r) => ({ date: r.date, repo: r.repo, views: r.views || 0, uniques: r.uniques || 0, clones: r.clones || 0 }))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.repo.localeCompare(b.repo)));

await fs.mkdir('data', { recursive: true });
await fs.writeFile(OUT, JSON.stringify(out));
console.log(`저장: ${OUT} (repo ${out.repos.length}, 방문 기록 ${out.traffic.length}행, 커밋 ${out.commits.length}행, Actions ${out.actions.length}건)`);
