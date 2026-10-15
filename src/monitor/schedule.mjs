/**
 * A 股开市时段判断。纯函数，不碰网络也不碰系统时区之外的东西。
 *
 * 交易时段（北京时间）：09:30–11:30、13:00–15:00，周一至周五。
 * 节假日不判断（需要交易日历，这里没有）——shortcut: 只按周末排除，
 * 法定节假日会误判为开市；要精确需要引入交易日历数据源。
 */

/** 北京时间的 时/分/周几，不依赖进程 TZ。 */
export function beijingNow(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
		hour12: false,
	}).formatToParts(now);
	const get = (t) => parts.find((p) => p.type === t)?.value;
	const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
	return { hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: wd };
}

/** 是否在开市时段。 */
export function isMarketOpen(now = new Date()) {
	const { hour, minute, weekday } = beijingNow(now);
	if (weekday === 0 || weekday === 6) return false;
	const m = hour * 60 + minute;
	return (m >= 9 * 60 + 30 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60);
}

/**
 * 距离下一个整点的毫秒数（至少 1 秒）。
 * 用来对齐到 10:00 / 11:00 / 14:00 这样的整点。
 */
export function msUntilNextHour(now = new Date()) {
	const next = new Date(now);
	next.setMinutes(0, 0, 0);
	next.setHours(next.getHours() + 1);
	return Math.max(next.getTime() - now.getTime(), 1000);
}
