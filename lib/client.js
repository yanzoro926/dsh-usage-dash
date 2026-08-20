window.__ModuleLoader__.load({
	id: "dsh-usage-dash",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const ReactDOM = require("react-dom");
		const { useState, useEffect } = React;
		const h = React.createElement;

		const POLL_MS = 60000;

		const ENABLED_KEY = "dsh-usage-dash.enabled";

		function loadEnabled() {
			try {
				return localStorage.getItem(ENABLED_KEY) !== "false";
			} catch {
				return true;
			}
		}

		const HIDDEN_KEY = "dsh-usage-dash.hidden";

		function loadHidden() {
			try {
				const raw = localStorage.getItem(HIDDEN_KEY);
				const arr = raw ? JSON.parse(raw) : [];
				return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
			} catch {
				return [];
			}
		}

		const PROVIDER_BLOCKS = [
			["opencode-go", "Go 额度"],
			["volc-coding-plan", "火山"],
			["deepseek", "DeepSeek"],
		];

		const FIXED_PROVIDER_IDS = PROVIDER_BLOCKS.map(([id]) => id);

		function titleOf(p) {
			const hit = PROVIDER_BLOCKS.find(([id]) => id === p.id);
			return hit ? hit[1] : p.name;
		}

		function orderedVisible(s) {
			const all = visibleProviders(s);
			const byId = new Map(all.map((p) => [p.id, p]));
			const out = [];
			for (const id of FIXED_PROVIDER_IDS) if (byId.has(id)) out.push(byId.get(id));
			for (const p of all) if (!FIXED_PROVIDER_IDS.includes(p.id)) out.push(p);
			return out;
		}

		// Module-level store shared by the sidebar badge and the overlay card
		// (both entries live in this one bundle, so a single store suffices).
		const store = {
			data: null,
			error: null,
			cardOpen: false,
			anchor: null,
			enabled: loadEnabled(),
			hidden: loadHidden(),
			listeners: new Set(),
			patch(p) {
				Object.assign(store, p);
				if ("hidden" in p) {
					try {
						localStorage.setItem(HIDDEN_KEY, JSON.stringify(p.hidden));
					} catch { /* storage unavailable */ }
				}
				if ("enabled" in p) {
					try {
						localStorage.setItem(ENABLED_KEY, p.enabled ? "true" : "false");
					} catch { /* storage unavailable */ }
				}
				for (const l of store.listeners) l();
			},
		};

		function toggleEnabled() {
			store.patch({ enabled: !store.enabled });
		}

		function toggleHidden(id) {
			const hidden = store.hidden.includes(id)
				? store.hidden.filter((x) => x !== id)
				: [...store.hidden, id];
			store.patch({ hidden });
		}

		function useStore() {
			const [, force] = useState(0);
			useEffect(() => {
				const l = () => force((n) => n + 1);
				store.listeners.add(l);
				return () => {
					store.listeners.delete(l);
				};
			}, []);
			return store;
		}

		async function refresh() {
			try {
				const res = await fetch("/usage-dash/api/summary", { cache: "no-store" });
				if (!res.ok) throw new Error("HTTP " + res.status);
				store.patch({ data: await res.json(), error: null });
			} catch (e) {
				store.patch({ error: String((e && e.message) || e) });
			}
		}

		async function postApi(method, body) {
			try {
				const res = await fetch("/usage-dash/api/" + method, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body || {}),
				});
				return await res.json();
			} catch (e) {
				return { ok: false, error: String((e && e.message) || e) };
			}
		}

		function providersOf(s) {
			return (s.data && s.data.providers) || [];
		}

		function prov(s, id) {
			return providersOf(s).find((p) => p.id === id) || null;
		}

		function visibleProviders(s) {
			return providersOf(s).filter((p) => !store.hidden.includes(p.id));
		}

		function worstWindow(s) {
			let worst = null;
			for (const p of visibleProviders(s)) {
				for (const w of p.windows || []) {
					if (!worst || w.pct > worst.pct) worst = w;
				}
			}
			return worst;
		}

		function fmtPct(n) {
			const v = Number(n) || 0;
			if (v > 0 && v < 1) return v.toFixed(1) + "%";
			return Math.round(v) + "%";
		}

		function remainingOf(w) {
			return Math.max(0, 100 - (Number(w.pct) || 0));
		}

		function remColor(r) {
			if (r <= 10) return "#d9534f";
			if (r <= 40) return "#e6a23c";
			return undefined;
		}

		function fmtUsd(n) {
			return "$" + Number(n || 0).toFixed(2);
		}

		function fmtMoney(b) {
			const sym = b.currency === "CNY" ? "¥" : b.currency === "USD" ? "$" : (b.currency || "") + " ";
			return sym + Number(b.total || 0).toFixed(2);
		}

		function balanceColor(b) {
			if (b.isAvailable === false) return "#d9534f";
			return undefined;
		}

		function fmtReset(ms) {
			if (ms == null) return "—";
			const d = ms - Date.now();
			if (d <= 0) return "即将重置";
			const hh = Math.floor(d / 3600000);
			const mm = Math.floor((d % 3600000) / 60000);
			if (hh >= 48) return Math.floor(hh / 24) + "d" + (hh % 24) + "h";
			if (hh > 0) return hh + "h" + mm + "m";
			return mm + "m";
		}

		function fmtAgo(ms) {
			if (ms == null) return "";
			const d = Date.now() - ms;
			if (d < 60000) return "刚刚";
			if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
			if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
			return Math.floor(d / 86400000) + " 天前";
		}

		const WINDOW_LABELS = { rolling5h: "5h", weekly: "wk", monthly: "30d", session: "session" };

		// Theme-adaptive colors: read DSH design tokens, fall back to neutrals.
		const T = {
			label: "var(--dsw-alias-label-primary, #333)",
			secondary: "var(--dsw-alias-label-secondary, #777)",
			border: "var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
			panel: "var(--dsw-specific-sidebar-fill, #fff)",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))",
		};

		// ── DeepSeek 官方峰谷时段 ────────────────────────────────────────────
		//
		// 官方定价页（api-docs.deepseek.com/zh-cn/quick_start/pricing）：
		//   「高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）」
		// 闲时价格为高峰价格的一半。北京时间 = UTC+8、无夏令时。
		const DS_PEAK_WINDOWS = [
			[9 * 60, 12 * 60],
			[14 * 60, 18 * 60],
		];
		const DS_PEAK_TEXT = "高峰 09:00-12:00 / 14:00-18:00（北京时间），其余为闲时";

		function deepSeekPeakState(nowMs) {
			const bj = new Date(nowMs + 8 * 3600 * 1000); // 北京时间（UTC+8）
			const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
			const peak = DS_PEAK_WINDOWS.some(([s, e]) => m >= s && m < e);
			return {
				peak,
				label: peak ? "忙时" : "闲时",
				color: peak ? "#e6a23c" : "#4caf50",
			};
		}

		function peakDot(nowMs, size) {
			const st = deepSeekPeakState(nowMs);
			return h("span", {
				title: "DeepSeek " + st.label + "（" + DS_PEAK_TEXT + "，闲时半价）",
				"aria-label": "DeepSeek " + st.label,
				style: {
					display: "inline-block",
					width: size,
					height: size,
					borderRadius: "50%",
					background: st.color,
					boxShadow: "0 0 5px " + st.color + "88",
					flex: "none",
				},
			});
		}

		// ── Sidebar footer badge ─────────────────────────────────────────────

		function percentLine(s, p) {
			// p: provider | null ; s.data null = still loading
			const loading = p == null && s.data == null;
			const windows = p ? p.windows || [] : [];
			const emptyText = p && p.note === "no-data" ? "无数据" : "无窗口";
			return h(
				"span",
				{ style: { display: "flex", gap: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } },
				loading
					? h("span", { style: { color: T.secondary } }, "加载中…")
					: windows.length === 0
					? h("span", { style: { color: T.secondary } }, emptyText)
					: windows.map((w) => {
							const r = remainingOf(w);
							return h(
								"span",
								{ key: w.key, style: { color: remColor(r) || T.secondary } },
								(WINDOW_LABELS[w.key] || w.label) + ": " + fmtPct(r)
							);
					  })
			);
		}

		function providerBlock(s, title, p) {
			const content =
				p && p.balance
					? h(
							"span",
							{ style: { color: balanceColor(p.balance) || T.secondary, fontVariantNumeric: "tabular-nums" } },
							fmtMoney(p.balance) + (p.balance.isAvailable === false ? "（不可用）" : "")
					  )
					: percentLine(s, p);
			// DeepSeek 标题旁带官方峰谷状态点：闲时绿 / 忙时橙。
			const titleNode =
				p && p.id === "deepseek"
					? h(
							"span",
							{ style: { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 } },
							peakDot(Date.now(), 8),
							h("span", { style: { fontWeight: 600, color: T.label, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, title)
					  )
					: h("span", { style: { fontWeight: 600, color: T.label, whiteSpace: "nowrap" } }, title);
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 2, textAlign: "left" } },
				titleNode,
				content
			);
		}

		function FooterBadge({ wide }) {
			const s = useStore();
			const [, force] = useState(0);
			// Keep the peak/off-peak dot and tooltip fresh near the
			// 9:00 / 12:00 / 14:00 / 18:00 Beijing-time boundaries.
			useEffect(() => {
				const t = setInterval(() => force((n) => n + 1), 30000);
				return () => clearInterval(t);
			}, []);
			if (!store.enabled) return null;
			const worst = worstWindow(s);
			const pctText = worst ? fmtPct(remainingOf(worst)) : "--";

			const toggle = (e) => {
				if (store.cardOpen) {
					store.patch({ cardOpen: false });
					return;
				}
				const rect = e && e.currentTarget ? e.currentTarget.getBoundingClientRect() : null;
				store.patch({
					cardOpen: true,
					anchor: rect ? { left: rect.left, top: rect.top } : null,
				});
			};

			if (wide) {
				const blocks = orderedVisible(s);
				const dsPeak = blocks.some((p) => p.id === "deepseek")
					? `DeepSeek ${deepSeekPeakState(Date.now()).label}（${DS_PEAK_TEXT}）`
					: null;
				const title = [
					...blocks
						.map((p) =>
							p.balance
								? `${titleOf(p)}: ${fmtMoney(p.balance)}`
								: p.windows && p.windows.length
								? `${titleOf(p)} 剩余: ${p.windows.map((w) => w.label + " " + fmtPct(remainingOf(w))).join(" · ")}`
								: null
						)
						.filter(Boolean),
					dsPeak,
				]
					.filter(Boolean)
					.join("\n");
				return h(
					"button",
					{
						type: "button",
						onClick: toggle,
						title,
						style: {
							boxSizing: "border-box",
							display: "flex",
							flexDirection: "column",
							alignItems: "stretch",
							textAlign: "left",
							gap: 6,
							width: "100%",
							border: "1px solid " + T.border,
							background: "transparent",
							color: T.label,
							borderRadius: 10,
							padding: "6px 8px",
							cursor: "pointer",
							fontSize: 12,
							lineHeight: "16px",
							overflow: "hidden",
						},
					},
					blocks.length === 0
						? h("span", { style: { color: T.secondary } }, "额度已全部隐藏（⚙ 开启）")
						: blocks.map((p) => providerBlock(s, titleOf(p), p))
				);
			}
			return h(
				"button",
				{
					type: "button",
					onClick: toggle,
					title: worst ? "最高用量 " + pctText : "额度数据加载中",
					style: {
						boxSizing: "border-box",
						width: 36,
						height: 36,
						borderRadius: "50%",
						border: "1px solid " + T.border,
						background: "transparent",
						color: T.label,
						cursor: "pointer",
						fontSize: 10,
						lineHeight: "14px",
						textAlign: "center",
						padding: 0,
					},
				},
				pctText
			);
		}

		// ── Overlay detail card ──────────────────────────────────────────────

		function windowRow(w) {
			const pct = Math.max(0, Math.min(100, Number(w.pct) || 0));
			const hasUsd = typeof w.spentUsd === "number" && typeof w.limitUsd === "number";
			const label = WINDOW_LABELS[w.key] || w.label;
			const rightText = hasUsd ? `剩余 ${fmtUsd(w.remainingUsd)}` : `剩余 ${fmtPct(100 - pct)}`;
			const leftSub = hasUsd ? `已用 ${pct.toFixed(1)}% · ${fmtUsd(w.spentUsd)}/${fmtUsd(w.limitUsd)}` : `已用 ${pct.toFixed(1)}%`;
			const resetFuture = w.resetAtMs != null && w.resetAtMs > Date.now();
			const rightSub =
				w.key === "rolling5h" && hasUsd
					? w.resetAtMs
						? "最旧用量 " + fmtReset(w.resetAtMs) + " 后滑出"
						: "滚动窗口"
					: resetFuture
					? "重置 " + fmtReset(w.resetAtMs)
					: "—";
			return h(
				"div",
				{ key: w.key, style: { display: "flex", flexDirection: "column", gap: 4 } },
				h(
					"div",
					{ style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
					h("span", { style: { fontSize: 13, fontWeight: 600, color: T.label } }, label),
					h("span", { style: { fontSize: 12, color: T.secondary } }, rightText)
				),
				h(
					"div",
					{ style: { height: 6, borderRadius: 3, background: T.hover, overflow: "hidden" } },
					h("div", {
						style: {
							height: "100%",
							width: pct + "%",
							borderRadius: 3,
							background: "var(--dsw-alias-label-primary, #555)",
							opacity: 0.75,
						},
					})
				),
				h(
					"div",
					{ style: { display: "flex", justifyContent: "space-between", fontSize: 11, color: T.secondary } },
					h("span", null, leftSub),
					h("span", null, rightSub)
				)
			);
		}

		function providerSection(p) {
			const plan = p.plan ? " · " + p.plan.charAt(0).toUpperCase() + p.plan.slice(1) : "";
			const stale = p.updatedAtMs ? " · 数据 " + fmtAgo(p.updatedAtMs) : "";
			const isOfficial = p.source === "opencode.ai API";
			const tokenLabel = p.tokenSource === "custom" ? "自定义 token" : p.tokenSource === "auth.json" ? "本机 auth.json" : "";
			const foot =
				p.id === "volc-coding-plan"
					? `${p.name} · 火山官方 OpenAPI（arkcli）${stale}`
					: p.id === "deepseek"
					? `${p.name} · 官方余额 API · api.deepseek.com · 现在${deepSeekPeakState(Date.now()).label}（${DS_PEAK_TEXT}，闲时半价）${stale}`
					: p.plan === "custom"
					? `${p.name} · 自定义套餐${stale}`
					: isOfficial
					? `${p.name} · 官方 API · ${tokenLabel}`
					: `${p.name} · 本机 opencode.db 本地估算 · 累计 ${fmtUsd(p.allTimeUsd)}`;
			const balanceBody = p.balance
				? (() => {
						const sym = p.balance.currency === "CNY" ? "¥" : p.balance.currency === "USD" ? "$" : (p.balance.currency || "") + " ";
						return h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 4 } },
							h(
								"div",
								{ style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
								h("span", { style: { fontSize: 13, fontWeight: 600, color: T.label } }, "总余额"),
								h("span", { style: { fontSize: 15, fontWeight: 700, color: balanceColor(p.balance) || T.label, fontVariantNumeric: "tabular-nums" } }, fmtMoney(p.balance))
							),
							h(
								"div",
								{ style: { display: "flex", justifyContent: "space-between", fontSize: 11, color: T.secondary } },
								h("span", null, "赠送 " + sym + Number(p.balance.granted || 0).toFixed(2)),
								h("span", null, "充值 " + sym + Number(p.balance.toppedUp || 0).toFixed(2))
							),
							p.balance.isAvailable === false
								? h("div", { style: { fontSize: 11, color: "#d9534f" } }, "余额不足，API 不可用")
								: null
						);
				  })()
				: null;
			return h(
				"div",
				{ key: p.id, style: { display: "flex", flexDirection: "column", gap: 8 } },
				h(
					"div",
					{ style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
					p.id === "deepseek"
						? (() => {
								const st = deepSeekPeakState(Date.now());
								return h(
									"span",
									{ style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: T.label, minWidth: 0 } },
									peakDot(Date.now(), 9),
									h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name + plan),
									h("span", { style: { fontSize: 11, fontWeight: 400, color: st.color, flex: "none" } }, st.label)
								);
						  })()
						: h("span", { style: { fontSize: 13, fontWeight: 700, color: T.label } }, p.name + plan),
					h("span", { style: { fontSize: 11, color: T.secondary } }, stale)
				),
				p.note === "no-data"
					? h("div", { style: { fontSize: 12, color: T.secondary } }, "未发现本地用量数据")
					: null,
				p.apiError
					? h("div", { style: { fontSize: 12, color: "#e6a23c" } }, "官方 API 不可用（" + p.apiError + "），以下为本机估算")
					: null,
				balanceBody
					? balanceBody
					: (p.windows || []).length > 0
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, (p.windows || []).map(windowRow))
					: h("div", { style: { fontSize: 12, color: T.secondary } }, "无窗口数据"),
				h("div", { style: { fontSize: 11, color: T.secondary, borderTop: "1px solid " + T.border, paddingTop: 6 } }, foot)
			);
		}

		function inputStyle() {
			return {
				boxSizing: "border-box",
				width: "100%",
				border: "1px solid " + T.border,
				background: "transparent",
				color: T.label,
				borderRadius: 8,
				padding: "6px 8px",
				fontSize: 12,
				outline: "none",
			};
		}

		function actionBtn(disabled) {
			return {
				border: "1px solid " + T.border,
				background: "transparent",
				color: T.label,
				borderRadius: 8,
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.5 : 1,
				fontSize: 12,
				lineHeight: "20px",
				padding: "2px 10px",
			};
		}

		function QuotaSettingsForm() {
			const [settings, setSettings] = useState(null);
			const [tokenInput, setTokenInput] = useState("");
			const [busy, setBusy] = useState(false);
			const [msg, setMsg] = useState(null);
			const [customName, setCustomName] = useState("");
			const [customUrl, setCustomUrl] = useState("");
			const [customToken, setCustomToken] = useState("");
			const [dsKeyInput, setDsKeyInput] = useState("");

			const loadSettings = async () => {
				setMsg(null);
				const j = await postApi("settings.get");
				setSettings(j);
			};
			useEffect(() => {
				loadSettings();
			}, []);

			const save = async () => {
				setBusy(true);
				const j = await postApi("settings.set-token", { token: tokenInput });
				setMsg(j.ok ? "已保存自定义 token（" + j.hint + "）" : "保存失败：" + ((j.error && j.error.message) || j.error || ""));
				setTokenInput("");
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const clear = async () => {
				setBusy(true);
				const j = await postApi("settings.clear-token");
				setMsg(j.ok ? "已清除自定义 token，回退为 auth.json 的 Go key" : "清除失败");
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const test = async () => {
				setBusy(true);
				const j = await postApi("settings.test", tokenInput.trim() ? { token: tokenInput.trim() } : {});
				if (j.ok) {
					setMsg("连接成功：HTTP " + j.httpStatus + " · " + (j.windows || []).map((w) => w.label + " " + fmtPct(w.pct)).join(" · "));
				} else if (j.error === "no-token") {
					setMsg(j.message || "未配置 token");
				} else {
					setMsg("连接失败：HTTP " + (j.httpStatus ?? "—") + " · " + (j.error || j.message || ""));
				}
				setBusy(false);
			};
			const volcRefresh = async () => {
				setBusy(true);
				const j = await postApi("settings.volc-refresh");
				if (j.ok && j.windows && j.windows.length > 0) {
					setMsg("火山查询成功：" + j.windows.map((w) => w.label + " 剩余 " + fmtPct(100 - w.pct)).join(" · "));
				} else if (j.ok) {
					setMsg("火山查询成功，但 coding-plan 未订阅或暂无数据" + (j.error ? "（" + j.error + "）" : ""));
				} else if (j.error === "no-cli") {
					setMsg("未安装 arkcli：请先执行 npm i @volcengine/ark-cli -g");
				} else {
					setMsg("火山查询失败：" + (j.error || ""));
				}
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const customAdd = async () => {
				setBusy(true);
				const j = await postApi("settings.custom-add", {
					name: customName,
					url: customUrl,
					token: customToken,
				});
				setMsg(j.ok ? "已添加自定义套餐「" + customName + "」" : "添加失败：" + ((j.error && j.error.message) || j.error || ""));
				if (j.ok) {
					setCustomName("");
					setCustomUrl("");
					setCustomToken("");
				}
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const customRemove = async (id) => {
				setBusy(true);
				const j = await postApi("settings.custom-remove", { id });
				setMsg(j.ok ? "已删除自定义套餐" : "删除失败");
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const dsSave = async () => {
				setBusy(true);
				const j = await postApi("settings.set-deepseek-token", { token: dsKeyInput });
				setMsg(j.ok ? "已保存 DeepSeek API key（" + j.hint + "）" : "保存失败：" + ((j.error && j.error.message) || j.error || ""));
				setDsKeyInput("");
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const dsClear = async () => {
				setBusy(true);
				const j = await postApi("settings.clear-deepseek-token");
				setMsg(j.ok ? "已清除 DeepSeek API key" : "清除失败");
				setBusy(false);
				await loadSettings();
				refresh();
			};
			const dsTest = async () => {
				setBusy(true);
				const j = await postApi("settings.test-deepseek", dsKeyInput.trim() ? { token: dsKeyInput.trim() } : {});
				if (j.ok) {
					const sym = j.currency === "CNY" ? "¥" : j.currency === "USD" ? "$" : (j.currency || "") + " ";
					setMsg("余额查询成功：" + sym + Number(j.total || 0).toFixed(2) + "（赠送 " + sym + Number(j.granted || 0).toFixed(2) + " · 充值 " + sym + Number(j.toppedUp || 0).toFixed(2) + "）" + (j.isAvailable === false ? " · 余额不足不可用" : ""));
				} else if (j.error === "no-token") {
					setMsg(j.message || "未配置 DeepSeek API key");
				} else {
					setMsg("余额查询失败：" + (j.error || ""));
				}
				setBusy(false);
			};

			const go = settings && settings.go;
			const volc = settings && settings.volc;
			const deepseek = settings && settings.deepseek;
			const custom = (settings && settings.custom) || [];
			const toggleRows = [
				...PROVIDER_BLOCKS,
				...custom.map((p) => [p.id, p.name]),
			];

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10 } },
				h(
					"label",
					{ style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: T.label, cursor: "pointer", userSelect: "none" } },
					h("input", { type: "checkbox", checked: store.enabled, onChange: toggleEnabled, style: { accentColor: "var(--dsw-alias-brand-primary, #4c8bf5)", cursor: "pointer" } }),
					h("span", null, "启用额度显示"),
					h("span", { style: { fontSize: 11, fontWeight: 400, color: T.secondary } }, store.enabled ? "（已开启）" : "（已关闭——徽章和弹窗不再出现）")
				),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 6 } },
					h("span", { style: { fontSize: 12, fontWeight: 700, color: T.label } }, "显示设置"),
					toggleRows.map(([id, title]) =>
						h(
							"label",
							{
								key: id,
								style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.label, cursor: "pointer", userSelect: "none" },
							},
							h("input", {
								type: "checkbox",
								checked: !store.hidden.includes(id),
								onChange: () => toggleHidden(id),
								style: { accentColor: "var(--dsw-alias-brand-primary, #4c8bf5)", cursor: "pointer" },
							}),
							h("span", null, title + (store.hidden.includes(id) ? "（已隐藏）" : ""))
						)
					),
					h("span", { style: { fontSize: 11, color: T.secondary } }, "取消勾选后，徽章和弹窗都不再显示该订阅，随时可回来恢复")
				),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 6 } },
					h("span", { style: { fontSize: 12, fontWeight: 700, color: T.label } }, "OpenCode Go · 官方额度 API"),
					h("input", {
						type: "password",
						value: tokenInput,
						onChange: (e) => setTokenInput(e.target.value),
						placeholder: "粘贴原始 token（Fe26.2… 或 sk-…），留空则自动用本机 auth.json",
						disabled: busy,
						style: inputStyle(),
					}),
					h(
						"div",
						{ style: { display: "flex", gap: 6 } },
						h("button", { type: "button", onClick: save, disabled: busy || tokenInput.trim().length < 8, style: actionBtn(busy || tokenInput.trim().length < 8) }, "保存"),
						h("button", { type: "button", onClick: clear, disabled: busy, style: actionBtn(busy) }, "清除"),
						h("button", { type: "button", onClick: test, disabled: busy, style: actionBtn(busy) }, "测试连接")
					),
					go
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: T.secondary } },
								h("span", null, "token：" + (go.tokenSet ? go.tokenHint + "（" + (go.tokenSource === "custom" ? "自定义" : "本机 auth.json") + "）" : "未配置（自动尝试 auth.json）")),
								go.api && go.api.status === "ok"
									? h("span", null, "API：ok · " + (go.api.windows || []).map((w) => w.label + " " + fmtPct(w.pct)).join(" · "))
									: h("span", { style: { color: "#e6a23c" } }, "API：" + (go.api && go.api.error ? "失败 · " + go.api.error : "未连接"))
						  )
						: h("span", { style: { fontSize: 11, color: T.secondary } }, "加载中…")
				),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid " + T.border, paddingTop: 8 } },
					(() => {
						const st = deepSeekPeakState(Date.now());
						return h(
							"span",
							{ style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: T.label } },
							peakDot(Date.now(), 8),
							h("span", null, "DeepSeek 官方 API 余额"),
							h("span", { style: { fontSize: 11, fontWeight: 400, color: st.color } }, st.label)
						);
					})(),
					h("input", {
						type: "password",
						value: dsKeyInput,
						onChange: (e) => setDsKeyInput(e.target.value),
						placeholder: "粘贴 DeepSeek API key（platform.deepseek.com/api_keys 创建）",
						disabled: busy,
						style: inputStyle(),
					}),
					h(
						"div",
						{ style: { display: "flex", gap: 6 } },
						h("button", { type: "button", onClick: dsSave, disabled: busy || dsKeyInput.trim().length < 8, style: actionBtn(busy || dsKeyInput.trim().length < 8) }, "保存"),
						h("button", { type: "button", onClick: dsClear, disabled: busy, style: actionBtn(busy) }, "清除"),
						h("button", { type: "button", onClick: dsTest, disabled: busy, style: actionBtn(busy) }, "测试")
					),
					deepseek
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: T.secondary } },
								h("span", null, "key：" + (deepseek.keySet ? deepseek.keyHint : "未配置")),
								deepseek.balance && deepseek.balance.status === "ok"
									? (() => {
											const sym = deepseek.balance.currency === "CNY" ? "¥" : deepseek.balance.currency === "USD" ? "$" : (deepseek.balance.currency || "") + " ";
											return h("span", null, "余额：" + sym + Number(deepseek.balance.total || 0).toFixed(2) + "（赠送 " + sym + Number(deepseek.balance.granted || 0).toFixed(2) + " · 充值 " + sym + Number(deepseek.balance.toppedUp || 0).toFixed(2) + "）" + (deepseek.balance.isAvailable === false ? " · 余额不足" : ""));
									  })()
									: h("span", { style: { color: "#e6a23c" } }, deepseek.balance && deepseek.balance.error ? "余额查询失败：" + deepseek.balance.error : "未查询余额")
						  )
						: h("span", { style: { fontSize: 11, color: T.secondary } }, "加载中…")
				),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid " + T.border, paddingTop: 8 } },
					h("span", { style: { fontSize: 12, fontWeight: 700, color: T.label } }, "火山引擎 CodingPlan"),
					volc
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: T.secondary } },
								volc.status === "ok"
									? h("span", null, "已订阅 coding-plan" + (volc.edition ? " · " + volc.edition : "") + (volc.updatedAtMs ? " · 数据 " + fmtAgo(volc.updatedAtMs) : "") + "：" + (volc.windows || []).map((w) => w.label + " 剩余 " + fmtPct(100 - w.pct)).join(" · "))
									: volc.status === "none"
									? h("span", null, "未订阅 coding-plan（" + (volc.error || "") + "）")
									: h("span", { style: { color: "#e6a23c" } }, volc.error === "no-cli" ? "未安装 arkcli" : "查询失败：" + volc.error),
								h("span", null, "安装登录：npm i @volcengine/ark-cli -g，然后 arkcli auth login volc-sso（或配置 AK/SK）")
						  )
						: h("span", { style: { fontSize: 11, color: T.secondary } }, "加载中…"),
					h(
						"div",
						{ style: { display: "flex", gap: 6 } },
						h("button", { type: "button", onClick: volcRefresh, disabled: busy, style: actionBtn(busy) }, "立即查询")
					)
				),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid " + T.border, paddingTop: 8 } },
					h("span", { style: { fontSize: 12, fontWeight: 700, color: T.label } }, "自定义套餐"),
					custom.length === 0
						? h("span", { style: { fontSize: 11, color: T.secondary } }, "暂无自定义套餐——填写下方表单添加你自己的额度 API")
						: custom.map((p) =>
								h(
									"div",
									{
										key: p.id,
										style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: T.label },
									},
									h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name + " · " + p.url),
									p.tokenSet ? h("span", { style: { color: T.secondary } }, p.tokenHint) : null,
									h("button", { type: "button", onClick: () => customRemove(p.id), disabled: busy, style: actionBtn(busy) }, "删除")
								)
						  ),
					h("input", {
						type: "text",
						value: customName,
						onChange: (e) => setCustomName(e.target.value),
						placeholder: "套餐名称（如：Kimi Coding Plan）",
						disabled: busy,
						style: inputStyle(),
					}),
					h("input", {
						type: "text",
						value: customUrl,
						onChange: (e) => setCustomUrl(e.target.value),
						placeholder: "额度 API URL（https://…，返回 usage.rolling/weekly/monthly 或 windows 数组）",
						disabled: busy,
						style: inputStyle(),
					}),
					h("input", {
						type: "password",
						value: customToken,
						onChange: (e) => setCustomToken(e.target.value),
						placeholder: "Token（可选，默认 Authorization: Bearer <token>）",
						disabled: busy,
						style: inputStyle(),
					}),
					h(
						"div",
						{ style: { display: "flex", gap: 6 } },
						h("button", { type: "button", onClick: customAdd, disabled: busy || !customName.trim() || !/^https?:\/\//i.test(customUrl.trim()), style: actionBtn(busy || !customName.trim() || !/^https?:\/\//i.test(customUrl.trim())) }, "添加套餐")
					),
					h("span", { style: { fontSize: 11, color: T.secondary } }, "响应格式自动识别：{usage:{rolling,weekly,monthly:{percent,resetsAt}}} 或 {windows:[{label,percent,resetAt}]}")
				),
				msg
					? h("div", { style: { fontSize: 11, color: T.label, borderTop: "1px solid " + T.border, paddingTop: 6, wordBreak: "break-all" } }, msg)
					: null
			);
		}

		function SettingsView({ onBack }) {
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10 } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8 } },
					h("button", { type: "button", onClick: onBack, title: "返回", style: smallBtn() }, "←"),
					h("span", { style: { fontSize: 14, fontWeight: 700, flex: 1 } }, "设置")
				),
				h(QuotaSettingsForm)
			);
		}

		function SettingsSection() {
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10 } },
				h("span", { style: { fontSize: 12, color: T.secondary } }, "在侧栏底部展示各订阅额度的剩余百分比（OpenCode Go / 火山 CodingPlan / DeepSeek 余额 / 自定义套餐），DeepSeek 标题旁显示官方峰谷状态：闲时绿点、忙时橙点（高峰 09:00-12:00、14:00-18:00 北京时间）"),
				h(QuotaSettingsForm)
			);
		}

		function OverlayCard() {
			const s = useStore();
			if (!store.enabled) return null;
			const [view, setView] = useState("dash");
			const [, force] = useState(0);
			// Keep the reset countdowns fresh while the card is open.
			useEffect(() => {
				if (!s.cardOpen) return;
				const t = setInterval(() => force((n) => n + 1), 30000);
				return () => clearInterval(t);
			}, [s.cardOpen]);
			if (!s.cardOpen) return null;
			const providers = providersOf(s);
			const visible = visibleProviders(s);
			const close = () => {
				setView("dash");
				store.patch({ cardOpen: false });
			};
			// Anchor the card right above the sidebar badge that opened it.
			const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
			const vh = typeof window !== "undefined" ? window.innerHeight : 800;
			const anchor = store.anchor || { left: 12, top: vh - 140 };
			const cardLeft = Math.max(8, Math.min(anchor.left, vw - 336));
			const cardBottom = Math.max(8, vh - anchor.top + 8);
			// Portal straight to document.body: the shell.overlay container sits
			// in a stacking context below better-sidebar's fixed right panel, so
			// staying inside it would keep the card hidden behind that panel.
			return ReactDOM.createPortal(
				h(
					"div",
					{
						style: {
							position: "fixed",
							inset: 0,
							pointerEvents: "auto",
							zIndex: 2147483000,
						},
						onClick: close,
					},
				h(
					"div",
					{
						onClick: (e) => e.stopPropagation(),
						style: {
							position: "absolute",
							left: cardLeft,
							bottom: cardBottom,
							width: 320,
							boxSizing: "border-box",
							background: T.panel,
							color: T.label,
							border: "1px solid " + T.border,
							borderRadius: 14,
							padding: "12px 14px",
							boxShadow: "0 8px 24px rgba(0,0,0,.18)",
							display: "flex",
							flexDirection: "column",
							gap: 12,
						},
					},
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8 } },
						view === "dash"
							? h("span", { style: { fontSize: 14, fontWeight: 700, flex: 1 } }, "Coding Plan 额度")
							: null,
						view === "dash"
							? h("button", { type: "button", onClick: () => setView("settings"), title: "设置", style: smallBtn() }, "⚙")
							: null,
						view === "dash"
							? h("button", { type: "button", onClick: refresh, title: "刷新", style: smallBtn() }, "⟳")
							: null,
						h("button", { type: "button", onClick: close, title: "关闭", style: smallBtn() }, "×")
					),
					view === "settings"
						? h(SettingsView, { onBack: () => setView("dash") })
						: s.error
						? h("div", { style: { fontSize: 12, color: "#d9534f" } }, "加载失败：" + s.error)
						: providers.length === 0
						? h("div", { style: { fontSize: 12, color: T.secondary } }, s.data == null ? "加载中…" : "无数据")
						: visible.length === 0
						? h("div", { style: { fontSize: 12, color: T.secondary } }, "所有订阅已隐藏（⚙ 设置里开启）")
						: visible.map(providerSection),
					view === "settings"
						? null
						: h(
								"div",
								{ style: { fontSize: 11, color: T.secondary, borderTop: "1px solid " + T.border, paddingTop: 8 } },
								"每 60 秒自动刷新 · Go 优先官方 API，失败回退本机估算"
						  )
					),
				),
				document.body
			);
		}

		function smallBtn() {
			return {
				width: 24,
				height: 24,
				border: "1px solid " + T.border,
				background: "transparent",
				color: T.label,
				borderRadius: 6,
				cursor: "pointer",
				fontSize: 13,
				lineHeight: "20px",
				padding: 0,
				textAlign: "center",
			};
		}

		// ── Plugin body ──────────────────────────────────────────────────────

		function apply(ctx) {
			try {
				ctx.effect(
					() => {
						const d1 = ctx.slots.register({ name: "sidebar.footer.action", id: "usage-dash", order: 100 }, FooterBadge);
						const d2 = ctx.slots.register({ name: "shell.overlay", id: "usage-dash-card", order: 100 }, OverlayCard);
						return () => {
							d1();
							d2();
						};
					},
					"dsh-usage-dash: footer badge + overlay card"
				);
				ctx.effect(
					() => ctx.slots.inject("settings.section", () => ctx.slots.register(
						{ name: "settings.section", id: "usage-dash", order: 90, label: "额度显示" },
						SettingsSection
					)),
					"dsh-usage-dash: settings section"
				);
				ctx.effect(
					() => {
						refresh();
						const t = setInterval(refresh, POLL_MS);
						return () => clearInterval(t);
					},
					"dsh-usage-dash: polling"
				);
			} catch (error) {
				console.error("[dsh-usage-dash] load failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
