// 自检：指标公式必须对得上手算结果，否则整个分析都是错的。
import assert from "node:assert";
import { toTencentSymbol } from "../src/data/market.mjs";
import { sma, ema, rsi, macd, maxDrawdown, volatility, computeIndicators } from "../src/data/indicators.mjs";

// sma
assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
assert.equal(sma([1, 2], 5), undefined);

// ema：常数列的 ema 等于该常数
assert.equal(ema([5, 5, 5, 5, 5], 3), 5);
// 种子=sma(1,2,3)=2, k=2/(3+1)=0.5 -> i=3: 4*.5+2*.5=3 ; i=4: 5*.5+3*.5=4
assert.equal(ema([1, 2, 3, 4, 5], 3), 4);

// rsi：单调上涨=100，单调下跌=0，常数列=100（loss=0 的约定）
assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14), 100);
assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14), 0);
assert.equal(rsi(Array(20).fill(50), 14), 100);

// maxDrawdown
assert.equal(maxDrawdown([100, 120, 60, 80]), 0.5);
assert.equal(maxDrawdown([100, 110, 120]), 0);

// volatility：常数列为 0
assert.equal(volatility(Array(30).fill(100), 20), 0);
assert.ok(volatility(Array.from({ length: 30 }, (_, i) => 100 + (i % 2) * 5), 20) > 0);

// macd：常数列全 0
const flat = macd(Array(60).fill(100));
assert.ok(Math.abs(flat.dif) < 1e-9 && Math.abs(flat.hist) < 1e-9);

// A 股代码规范化
assert.equal(toTencentSymbol("600519"), "sh600519"); // 沪市主板
assert.equal(toTencentSymbol("688981"), "sh688981"); // 科创板
assert.equal(toTencentSymbol("000001"), "sz000001"); // 深市主板
assert.equal(toTencentSymbol("300750"), "sz300750"); // 创业板
assert.equal(toTencentSymbol("830799"), "bj830799"); // 北交所
assert.equal(toTencentSymbol("510300"), "sh510300"); // 沪市 ETF
assert.equal(toTencentSymbol("588000"), "sh588000"); // 科创50 ETF
assert.equal(toTencentSymbol("159915"), "sz159915"); // 深市 ETF（曾是 bug：被误判为沪市）
assert.equal(toTencentSymbol("sh600519"), "sh600519");
assert.equal(toTencentSymbol("上证"), "sh000001");
assert.throws(() => toTencentSymbol("AAPL"), /无法识别/); // 拒绝非 A 股

// 指标快照在数据不足时不能崩
const short = computeIndicators([
	{ date: "2026-01-01", open: 1, close: 1, high: 1, low: 1, volume: 1 },
	{ date: "2026-01-02", open: 2, close: 2, high: 2, low: 2, volume: 1 },
]);
assert.equal(short.ma20, undefined);
assert.equal(short.rsi14, undefined);
assert.ok(Array.isArray(short.signals));

console.log("指标自检通过");
