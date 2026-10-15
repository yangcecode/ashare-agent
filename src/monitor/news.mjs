/**
 * 新闻 + 公告采集（东方财富公开接口，无需 key）。
 *
 * 新闻：search-api-web.eastmoney.com（按关键词全文搜索，返回最近 N 条）
 * 公告：np-anotice-stock.eastmoney.com（按股票代码查公告列表）
 *
 * 两个都是非官方接口，字段随时可能变。去重靠 id（新闻 code / 公告 art_code），
 * 调用方自己维护已见集合。
 */

const UA = "Mozilla/5.0";
const TIMEOUT_MS = 12_000;

async function getJson(url, { referer, text = false } = {}) {
	const res = await fetch(url, {
		headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	if (text) return res.text();
	return res.json();
}

/** 去掉东财给标题/正文插的 <em> 高亮标签。 */
function stripTags(s) {
	return String(s ?? "").replace(/<\/?em>/g, "").replace(/<[^>]+>/g, "").trim();
}

/**
 * 搜个股新闻。
 * @param {string} keyword 股票名或代码
 * @param {number} size 条数
 * @returns {Promise<Array<{id:string,date:string,title:string,summary:string,source:string,url:string}>>}
 */
export async function fetchNews(keyword, size = 8) {
	const param = {
		uid: "",
		keyword: String(keyword),
		type: ["cmsArticleWebOld"],
		client: "web",
		clientType: "web",
		clientVersion: "curr",
		param: {
			cmsArticleWebOld: {
				searchScope: "default",
				sort: "time", // 按时间，盯盘要最新的
				pageIndex: 1,
				pageSize: size,
				preTag: "",
				postTag: "",
			},
		},
	};
	const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${encodeURIComponent(JSON.stringify(param))}`;
	const text = await getJson(url, { referer: "https://so.eastmoney.com/", text: true });
	// 返回是 JSONP：x({...})
	const json = JSON.parse(text.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, ""));
	const list = json?.result?.cmsArticleWebOld ?? [];
	return list.map((a) => ({
		id: String(a.code),
		date: a.date,
		title: stripTags(a.title),
		summary: stripTags(a.content).slice(0, 160),
		source: a.mediaName ?? "",
		url: a.url ?? "",
	}));
}

/**
 * 查个股公告。
 * @param {string} code 6 位代码
 * @param {number} size 条数
 * @returns {Promise<Array<{id:string,date:string,title:string,type:string,url:string}>>}
 */
export async function fetchAnnouncements(code, size = 5) {
	const c = String(code).replace(/^(sh|sz|bj)/i, "");
	const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${size}&page_index=1&ann_type=A&client_source=web&stock_list=${c}`;
	const json = await getJson(url, { referer: "https://data.eastmoney.com/" });
	const list = json?.data?.list ?? [];
	return list.map((a) => ({
		id: String(a.art_code),
		date: (a.notice_date ?? a.display_time ?? "").slice(0, 10),
		title: stripTags(a.title_ch ?? a.title),
		type: (a.columns ?? []).map((x) => x.column_name).filter(Boolean).join("/"),
		url: a.art_code ? `https://data.eastmoney.com/notices/detail/${c}/${a.art_code}.html` : "",
	}));
}

/**
 * 一次取全：新闻 + 公告，并过滤掉已见过的 id。
 * @param {{code:string,name:string}} stock
 * @param {{seen?:Set<string>}} [opts]
 */
export async function fetchDisclosures(stock, { seen = new Set() } = {}) {
	const keyword = stock.name || stock.code;
	const [news, anns] = await Promise.allSettled([
		fetchNews(keyword, 8),
		fetchAnnouncements(stock.code, 5),
	]);
	const pick = (r) => (r.status === "fulfilled" ? r.value : []);
	const fresh = (items) => items.filter((i) => i.id && !seen.has(i.id));
	return {
		news: fresh(pick(news)),
		announcements: fresh(pick(anns)),
		errors: [news, anns].filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? String(r.reason)),
	};
}
