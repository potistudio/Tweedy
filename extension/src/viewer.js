/*
 * 保存済みツイートの一覧ページ。
 * IndexedDB を直接読み書きする。ツイートのメタデータは起動時に全件メモリへ読み込み、
 * 絞り込み・並べ替えはメモリ上で行う。メディア blob はカードが表示領域に近づいた時点で読み込む。
 */
import * as db from "./db.js";

const ALL = "__all";
const PAGE = 24;
const DRAG_TYPE = "application/x-tvault-id";
const PREFS_KEY = "tvault:prefs";

const state = {
	tweets: [],
	byId: new Map(),
	folders: [],
	folder: ALL,
	tagFilter: new Set(),
	q: "",
	sort: "saved-desc",
	layout: "grid",
	list: [],
	rendered: 0,
};

// カードごとに生成した object URL。カード破棄時に revoke してメモリを解放する。
const urlsByCard = new Map();
const hayCache = new WeakMap();

const $ = (sel) => document.querySelector(sel);
const els = {
	side: $("#side"),
	folderList: $("#folderList"),
	tagList: $("#tagList"),
	newFolderForm: $("#newFolderForm"),
	newFolderName: $("#newFolderName"),
	usage: $("#usage"),
	q: $("#q"),
	sort: $("#sort"),
	grid: $("#grid"),
	sentinel: $("#sentinel"),
	empty: $("#empty"),
	viewTitle: $("#viewTitle"),
	viewCount: $("#viewCount"),
	activeFilters: $("#activeFilters"),
	banner: $("#banner"),
	datalist: $("#tagSuggestions"),
	settings: $("#settings"),
	hideNative: $("#hideNative"),
	ioProgress: $("#ioProgress"),
	importFile: $("#importFile"),
	lightbox: $("#lightbox"),
	lbImg: $("#lbImg"),
};

/* ---------- utilities ---------- */

function h(tag, props, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props || {})) {
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "dataset") Object.assign(el.dataset, v);
		else if (k === "style") Object.assign(el.style, v);
		else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) {
		if (c == null || c === false) continue;
		el.append(c instanceof Node ? c : String(c));
	}
	return el;
}

// インポートしたデータ由来の URL を href に入れるため、http(s) 以外のスキームを拒否する。
function safeHref(url) {
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
	} catch {
		return "";
	}
}

function loadPrefs() {
	try {
		const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
		if (typeof p.sort === "string") state.sort = p.sort;
		if (p.layout === "grid" || p.layout === "list") state.layout = p.layout;
	} catch {
		/* 既定値を使う */
	}
}

function savePrefs() {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify({ sort: state.sort, layout: state.layout }));
	} catch {
		/* 保存できない環境では毎回既定値になる */
	}
}

function formatDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const sameYear = d.getFullYear() === now.getFullYear();
	return d.toLocaleDateString(
		"ja-JP",
		sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
	);
}

function formatBytes(n) {
	if (!Number.isFinite(n)) return "";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function shortUrl(url) {
	const s = url.replace(/^https?:\/\/(www\.)?/, "");
	return s.length > 42 ? `${s.slice(0, 41)}…` : s;
}

const TOKEN_RE = /https?:\/\/[^\s]+|@\w{1,15}|[#＃][\p{L}\p{N}_]+/gu;

function linkify(text) {
	const frag = document.createDocumentFragment();
	let last = 0;
	for (const m of text.matchAll(TOKEN_RE)) {
		let s = m[0];
		const i = m.index;
		const prev = i > 0 ? text[i - 1] : "";
		if (!s.startsWith("http") && prev && /[\p{L}\p{N}_@#&]/u.test(prev)) continue;
		if (s.startsWith("http")) s = s.replace(/[)\]」』、。,.!?！？]+$/u, "");
		let href;
		if (s.startsWith("http")) href = safeHref(s);
		else if (s[0] === "@") href = `https://x.com/${s.slice(1)}`;
		else href = `https://x.com/hashtag/${encodeURIComponent(s.slice(1))}`;
		if (!href) continue;
		frag.append(text.slice(last, i));
		frag.append(
			h("a", { href, target: "_blank", rel: "noopener noreferrer" }, s.startsWith("http") ? shortUrl(s) : s),
		);
		last = i + s.length;
	}
	frag.append(text.slice(last));
	return frag;
}

function folderName(id) {
	const f = state.folders.find((x) => x.id === id);
	return f ? f.name : "未分類";
}

/* ---------- data ---------- */

async function reload() {
	const [tweets, folders] = await Promise.all([db.listTweets(), db.listFolders()]);
	state.tweets = tweets;
	state.byId = new Map(tweets.map((t) => [t.id, t]));
	state.folders = folders;
	if (state.folder !== ALL && !folders.some((f) => f.id === state.folder)) state.folder = ALL;
	els.banner.hidden = true;
	renderSidebar();
	applyFilter();
}

function replaceTweet(r) {
	const i = state.tweets.findIndex((t) => t.id === r.id);
	if (i >= 0) state.tweets[i] = r;
	else state.tweets.push(r);
	state.byId.set(r.id, r);
	const j = state.list.findIndex((t) => t.id === r.id);
	if (j >= 0) state.list[j] = r;
}

function haystack(t) {
	let s = hayCache.get(t);
	if (s) return s;
	const parts = [t.text, t.author?.name, `@${t.author?.screenName || ""}`, ...(t.tags || []).map((x) => `#${x}`)];
	if (t.quote) parts.push(t.quote.text, t.quote.author?.name, `@${t.quote.author?.screenName || ""}`);
	s = parts.filter(Boolean).join("\n").toLowerCase();
	hayCache.set(t, s);
	return s;
}

function matches(t) {
	if (state.folder !== ALL && t.folderId !== state.folder) return false;
	if (state.tagFilter.size) {
		const tags = new Set((t.tags || []).map((x) => x.toLowerCase()));
		for (const tag of state.tagFilter) if (!tags.has(tag.toLowerCase())) return false;
	}
	if (state.q) {
		const hay = haystack(t);
		for (const term of state.q.toLowerCase().split(/\s+/)) if (term && !hay.includes(term)) return false;
	}
	return true;
}

// ツイート ID は投稿時刻を上位ビットに持つため、桁数→文字列の順で比較すると投稿順になる。
function compareId(a, b) {
	return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const SORTS = {
	"saved-desc": (a, b) => b.savedAt - a.savedAt,
	"saved-asc": (a, b) => a.savedAt - b.savedAt,
	"created-desc": (a, b) => compareId(b, a),
	"created-asc": (a, b) => compareId(a, b),
};

/* ---------- sidebar ---------- */

function renderSidebar() {
	const counts = new Map();
	const tagCounts = new Map();
	for (const t of state.tweets) {
		counts.set(t.folderId, (counts.get(t.folderId) || 0) + 1);
		for (const tag of t.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
	}

	els.folderList.textContent = "";
	els.folderList.append(folderItem({ id: ALL, name: "すべて" }, state.tweets.length));
	for (const f of state.folders) els.folderList.append(folderItem(f, counts.get(f.id) || 0));

	const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	els.tagList.textContent = "";
	if (!tags.length) {
		els.tagList.append(
			h(
				"li",
				{ class: "nav-item", style: { color: "var(--sub)", cursor: "default", fontSize: "13px" } },
				"タグはまだありません",
			),
		);
	}
	for (const [tag, n] of tags) {
		const on = [...state.tagFilter].some((x) => x.toLowerCase() === tag.toLowerCase());
		els.tagList.append(
			h(
				"li",
				null,
				h(
					"button",
					{
						type: "button",
						class: `nav-item${on ? " active" : ""}`,
						onclick: () => toggleTag(tag),
					},
					h("span", { class: "name" }, `#${tag}`),
					h("span", { class: "count" }, n),
				),
			),
		);
	}

	els.datalist.textContent = "";
	for (const [tag] of tags) els.datalist.append(h("option", { value: tag }));

	updateUsage();
}

function folderItem(f, count) {
	const isAll = f.id === ALL;
	const item = h(
		"div",
		{
			class: `nav-item${state.folder === f.id ? " active" : ""}`,
			role: "button",
			tabindex: "0",
			dataset: { folder: f.id },
		},
		h("span", { class: "name" }, f.name),
		h("span", { class: "count" }, count),
	);

	const select = () => {
		state.folder = f.id;
		els.side.classList.remove("open");
		renderSidebar();
		applyFilter();
	};
	item.addEventListener("click", (e) => {
		if (e.target.closest(".acts, .rename")) return;
		select();
	});
	item.addEventListener("keydown", (e) => {
		if (e.target === item && (e.key === "Enter" || e.key === " ")) {
			e.preventDefault();
			select();
		}
	});

	if (!isAll) {
		const acts = h(
			"span",
			{ class: "acts" },
			h(
				"button",
				{
					type: "button",
					title: "名前を変更",
					"aria-label": `${f.name} の名前を変更`,
					onclick: () => startRename(item, f),
				},
				"✎",
			),
			f.id === db.DEFAULT_FOLDER_ID
				? null
				: h(
						"button",
						{
							type: "button",
							title: "削除",
							"aria-label": `${f.name} を削除`,
							onclick: () => removeFolder(f),
						},
						"🗑",
					),
		);
		item.append(acts);

		item.addEventListener("dragover", (e) => {
			if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			item.classList.add("drop");
		});
		item.addEventListener("dragleave", () => item.classList.remove("drop"));
		item.addEventListener("drop", (e) => {
			item.classList.remove("drop");
			const id = e.dataTransfer.getData(DRAG_TYPE);
			if (!id) return;
			e.preventDefault();
			moveTweet(id, f.id);
		});
	}
	return h("li", null, item);
}

function startRename(item, f) {
	const nameEl = item.querySelector(".name");
	const input = h("input", { class: "rename", value: f.name, maxlength: "60", "aria-label": "フォルダ名" });
	nameEl.replaceWith(input);
	input.focus();
	input.select();
	let done = false;
	const finish = async (commit) => {
		if (done) return;
		done = true;
		const name = input.value.trim();
		if (commit && name && name !== f.name) {
			try {
				await db.renameFolder(f.id, name);
				state.folders = await db.listFolders();
				refreshFolderSelects();
			} catch (err) {
				alert(err.message);
			}
		}
		renderSidebar();
		updateSummary();
	};
	input.addEventListener("keydown", (e) => {
		if (e.isComposing) return;
		if (e.key === "Enter") finish(true);
		else if (e.key === "Escape") finish(false);
	});
	input.addEventListener("blur", () => finish(true));
}

async function removeFolder(f) {
	if (
		!confirm(
			`フォルダ「${f.name}」を削除しますか？\n中のツイートは「${folderName(db.DEFAULT_FOLDER_ID)}」に移動します。`,
		)
	)
		return;
	try {
		await db.deleteFolder(f.id);
		if (state.folder === f.id) state.folder = ALL;
		await reload();
	} catch (err) {
		alert(err.message);
	}
}

async function updateUsage() {
	const n = state.tweets.length;
	let text = `${n.toLocaleString()} 件`;
	try {
		const est = await navigator.storage.estimate();
		if (est && Number.isFinite(est.usage)) text += ` ・ ${formatBytes(est.usage)} 使用中`;
	} catch {
		/* 推定値を取得できない場合は件数のみ表示する */
	}
	els.usage.textContent = text;
}

/* ---------- filter / list ---------- */

function toggleTag(tag) {
	const existing = [...state.tagFilter].find((x) => x.toLowerCase() === tag.toLowerCase());
	if (existing) state.tagFilter.delete(existing);
	else state.tagFilter.add(tag);
	renderSidebar();
	applyFilter();
}

function applyFilter() {
	state.list = state.tweets.filter(matches).sort(SORTS[state.sort] || SORTS["saved-desc"]);
	clearGrid();
	state.rendered = 0;
	renderMore();
	updateSummary();
	window.scrollTo({ top: 0 });
}

function updateSummary() {
	els.viewTitle.textContent = state.folder === ALL ? "すべて" : folderName(state.folder);
	els.viewCount.textContent = `${state.list.length.toLocaleString()} 件`;

	els.activeFilters.textContent = "";
	for (const tag of state.tagFilter) {
		els.activeFilters.append(
			h(
				"button",
				{ type: "button", class: "filter-chip", title: "絞り込みを解除", onclick: () => toggleTag(tag) },
				`#${tag} ×`,
			),
		);
	}
	if (state.tagFilter.size > 1) {
		els.activeFilters.append(
			h(
				"button",
				{
					type: "button",
					class: "filter-chip",
					onclick: () => {
						state.tagFilter.clear();
						renderSidebar();
						applyFilter();
					},
				},
				"すべて解除",
			),
		);
	}

	const empty = state.list.length === 0;
	els.empty.hidden = !empty;
	if (empty) {
		els.empty.textContent = "";
		if (state.tweets.length === 0) {
			els.empty.append(
				h("strong", null, "まだ保存されたツイートがありません"),
				h("br"),
				"X のツイートの下にある箱のアイコンを押すと、メディアごとここに保存されます。",
			);
		} else {
			els.empty.append("条件に一致するツイートがありません");
		}
	}
}

/* ---------- masonry ---------- */
/*
 * 行単位で高さを揃えると高さの異なるカードの下に空白が生じるため、列ごとに独立して積む。
 * 各列への振り分けは state.list の順に、その時点で最も低い列を選ぶ。
 * DOM 上の順序は列ごとになるため、Tab キーによるフォーカス移動は列単位で進む。
 * 列の最小幅 (--col-min)、リスト表示の幅 (--list-width)、列間の横の間隔 (column-gap) は .grid の値を、
 * カード間の縦の間隔 (row-gap) は .col の値を参照する。.col には padding / border を指定しない。
 */
let columns = [];

function columnGeometry() {
	const style = getComputedStyle(els.grid);
	const gridWidth = els.grid.clientWidth;
	if (state.layout === "list") {
		const listWidth = parseFloat(style.getPropertyValue("--list-width")) || 620;
		return { count: 1, width: Math.min(listWidth, gridWidth) };
	}
	const min = parseFloat(style.getPropertyValue("--col-min")) || 320;
	const gap = parseFloat(style.columnGap) || 0;
	const count = Math.max(1, Math.floor((gridWidth + gap) / (min + gap)));
	return { count, width: (gridWidth - gap * (count - 1)) / count };
}

function columnCount() {
	return columnGeometry().count;
}

function buildColumns(n) {
	columns = Array.from({ length: n }, () => h("div", { class: "col" }));
	els.grid.replaceChildren(...columns);
}

/*
 * カードごとに高さを読むと追加のたびに強制レイアウトが発生するため、
 * 先頭列へ一括で追加して高さをまとめて測定し、測定値を基に振り分ける。
 * 全列は同じ幅であるため、列幅が測定時から変わらない限り、振り分け後のカードの高さは測定値と一致する。
 */
function placeCards(cards, knownHeights = null) {
	if (!columns.length || !columns[0].isConnected) buildColumns(columnCount());
	if (!cards.length) return;
	const heights = columns.map((c) => c.offsetHeight);
	const filled = columns.map((c) => c.childElementCount > 0);
	const gap = parseFloat(getComputedStyle(columns[0]).rowGap) || 0;
	let cardHeights = knownHeights;
	if (!cardHeights) {
		columns[0].append(...cards);
		cardHeights = cards.map((c) => c.offsetHeight);
	}
	cards.forEach((card, i) => {
		let j = 0;
		for (let k = 1; k < heights.length; k++) if (heights[k] < heights[j]) j = k;
		columns[j].append(card);
		heights[j] += (filled[j] ? gap : 0) + cardHeights[i];
		filled[j] = true;
	});
}

/*
 * 再配置は描画済みの全カードの移動を伴うため、列数の変化時と force 指定時のみ行う。
 * DOM 上の順序は列ごとであり state.list の順序と異なるため、state.list の順に並べ替えてから振り分ける。
 * DOM への再挿入はカードごとのスタイル再計算を伴うため、高さは移動前の位置で新しい列幅を一時的に指定して測定し、
 * 再挿入を 1 回に抑える。
 * 幅が 0 の場合 (非表示の祖先要素がある場合など) は測定値が無効となるため、再配置しない。
 */
function relayout(force = false) {
	const { count, width } = columnGeometry();
	if (!(width > 0)) return;
	if (!force && count === columns.length && columns[0]?.isConnected) return;
	const order = new Map(state.list.slice(0, state.rendered).map((t, i) => [t.id, i]));
	const rank = (card) => order.get(card.dataset.id) ?? Number.MAX_SAFE_INTEGER;
	const cards = [...els.grid.querySelectorAll(".col > .card")].sort((a, b) => rank(a) - rank(b));
	const prevWidths = cards.map((c) => c.style.width);
	let heights;
	try {
		for (const card of cards) card.style.width = `${width}px`;
		heights = cards.map((c) => c.offsetHeight);
	} finally {
		cards.forEach((card, i) => {
			card.style.width = prevWidths[i];
		});
	}
	buildColumns(count);
	placeCards(cards, heights);
}

new ResizeObserver(() => relayout()).observe(els.grid);

function renderMore() {
	const next = state.list.slice(state.rendered, state.rendered + PAGE);
	if (!next.length) return;
	placeCards(next.map(buildCard));
	state.rendered += next.length;
	// 追加後も sentinel が表示領域内に残る場合、IntersectionObserver は再通知しないため続けて描画する。
	requestAnimationFrame(() => {
		if (state.rendered < state.list.length && els.sentinel.getBoundingClientRect().top < innerHeight + 800)
			renderMore();
	});
}

function clearGrid() {
	for (const urls of urlsByCard.values()) for (const u of urls) URL.revokeObjectURL(u);
	urlsByCard.clear();
	mediaObserver.disconnect();
	els.grid.textContent = "";
	columns = [];
}

function cardOf(id) {
	return els.grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
}

function dropCard(id) {
	const card = cardOf(id);
	// relayout は state.list と state.rendered を基に並べ替えるため、DOM の変更より先に更新する。
	const j = state.list.findIndex((t) => t.id === id);
	if (j >= 0) {
		state.list.splice(j, 1);
		if (j < state.rendered) state.rendered--;
	}
	for (const u of urlsByCard.get(id) || []) URL.revokeObjectURL(u);
	urlsByCard.delete(id);
	if (card) {
		mediaObserver.unobserve(card);
		const col = card.parentElement;
		card.remove();
		// 空になった列が残ると表示上の列数が減るため、残りのカードを再配置する。リスト表示は 1 列のため対象外とする。
		if (col && col.classList.contains("col") && !col.firstElementChild && state.layout !== "list") relayout(true);
	}
}

// 編集によって現在の絞り込み条件に一致しなくなったカードを一覧から外す。
function syncMembership(id) {
	const t = state.byId.get(id);
	if (!t || !matches(t)) dropCard(id);
	updateSummary();
}

const mediaObserver = new IntersectionObserver(
	(entries) => {
		for (const e of entries) {
			if (!e.isIntersecting) continue;
			mediaObserver.unobserve(e.target);
			hydrate(e.target);
		}
	},
	{ rootMargin: "600px 0px" },
);

new IntersectionObserver(
	(entries) => {
		if (entries.some((e) => e.isIntersecting) && state.rendered < state.list.length) renderMore();
	},
	{ rootMargin: "800px 0px" },
).observe(els.sentinel);

/* ---------- card ---------- */

function buildHead(t, compact) {
	const a = t.author || {};
	const profile = a.screenName ? `https://x.com/${encodeURIComponent(a.screenName)}` : null;
	return h(
		"div",
		{ class: "card-head" },
		h("img", { class: "avatar", alt: "", dataset: { avatar: a.avatarUrl || "" } }),
		h(
			"div",
			{ class: "who" },
			h(
				"a",
				{ class: "name", href: profile, target: "_blank", rel: "noopener noreferrer" },
				a.name || a.screenName || "不明なユーザー",
			),
			a.screenName ? h("span", { class: "handle" }, `@${a.screenName}`) : null,
		),
		compact
			? null
			: h(
					"time",
					{
						datetime: t.createdAt || null,
						title: t.createdAt ? new Date(t.createdAt).toLocaleString("ja-JP") : null,
					},
					formatDate(t.createdAt),
				),
	);
}

function buildText(text, clampable) {
	const el = h("div", { class: "text" }, linkify(text));
	if (!clampable || text.length < 420) return [el];
	el.classList.add("clamp");
	const more = h("button", { type: "button", class: "more" }, "もっと見る");
	more.addEventListener("click", () => {
		const clamped = el.classList.toggle("clamp");
		more.textContent = clamped ? "もっと見る" : "折りたたむ";
	});
	return [el, more];
}

function buildMedia(media) {
	const items = media.slice(0, 4);
	const box = h("div", { class: `media n${items.length}` });
	for (const m of items) {
		const slot = h("div", { class: "m-item", dataset: { key: m.key } });
		if (items.length === 1 && m.width && m.height) slot.style.aspectRatio = `${m.width} / ${m.height}`;
		box.append(slot);
	}
	return box;
}

function buildCard(t) {
	const card = h("article", { class: "card", dataset: { id: t.id } });
	const head = buildHead(t, false);
	const handle = h(
		"button",
		{
			type: "button",
			class: "drag-handle",
			draggable: "true",
			title: "ドラッグしてフォルダへ移動",
			"aria-label": "ドラッグしてフォルダへ移動",
		},
		"⠿",
	);
	handle.addEventListener("dragstart", (e) => {
		e.dataTransfer.setData(DRAG_TYPE, t.id);
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setDragImage(card, 20, 20);
		card.classList.add("dragging");
	});
	handle.addEventListener("dragend", () => card.classList.remove("dragging"));
	head.append(handle);
	card.append(head);

	if (t.text) card.append(...buildText(t.text, true));
	if (t.media && t.media.length) card.append(buildMedia(t.media));
	if (t.quote) {
		const q = t.quote;
		const quote = h("div", { class: "quote" }, buildHead(q, true));
		if (q.text) quote.append(...buildText(q.text, false));
		if (q.media && q.media.length) quote.append(buildMedia(q.media));
		const qHref = safeHref(q.url);
		if (qHref)
			quote.append(
				h(
					"a",
					{ href: qHref, target: "_blank", rel: "noopener noreferrer", style: { fontSize: "13px" } },
					"引用元を開く",
				),
			);
		card.append(quote);
	}
	card.append(buildFoot(t));
	mediaObserver.observe(card);
	return card;
}

function buildFoot(t) {
	const select = h("select", { class: "folder-select", "aria-label": "フォルダ" });
	fillFolderOptions(select, t.folderId);
	select.addEventListener("change", () => moveTweet(t.id, select.value));

	const href = safeHref(t.url);
	const chips = h("div", { class: "chips" });
	renderChips(chips, t.id, false);
	const missing = missingMediaCount(t);
	return h(
		"div",
		{ class: "card-foot" },
		h(
			"div",
			{ class: "foot-row" },
			select,
			href
				? h("a", { class: "card-btn", href, target: "_blank", rel: "noopener noreferrer" }, "元ツイート")
				: null,
			h("button", { type: "button", class: "card-btn danger", onclick: () => removeTweet(t.id) }, "削除"),
		),
		missing
			? h(
					"div",
					{ class: "foot-row" },
					h(
						"button",
						{
							type: "button",
							class: "card-btn",
							title: "保存時に取得できなかったメディアを再取得します",
							onclick: (e) => retryMedia(t.id, e.currentTarget),
						},
						`メディアを再取得 (${missing})`,
					),
				)
			: null,
		chips,
	);
}

function fillFolderOptions(select, current) {
	select.textContent = "";
	for (const f of state.folders) select.append(h("option", { value: f.id }, f.name));
	select.value = state.folders.some((f) => f.id === current) ? current : db.DEFAULT_FOLDER_ID;
}

function refreshFolderSelects() {
	for (const select of els.grid.querySelectorAll(".card .folder-select")) {
		const id = select.closest(".card").dataset.id;
		fillFolderOptions(select, state.byId.get(id)?.folderId);
	}
}

function renderChips(chips, id, focusInput) {
	const t = state.byId.get(id);
	if (!t) return;
	chips.textContent = "";
	for (const tag of t.tags || []) {
		chips.append(
			h(
				"span",
				{ class: "chip" },
				h(
					"button",
					{ type: "button", class: "tag-name", title: "このタグで絞り込む", onclick: () => toggleTag(tag) },
					`#${tag}`,
				),
				h(
					"button",
					{
						type: "button",
						class: "x",
						"aria-label": `${tag} を外す`,
						onclick: () =>
							setTags(
								id,
								(state.byId.get(id)?.tags || []).filter((x) => x !== tag),
								false,
							),
					},
					"×",
				),
			),
		);
	}
	const input = h("input", {
		class: "tag-add",
		placeholder: "＋ タグ",
		list: "tagSuggestions",
		maxlength: "50",
		"aria-label": "タグを追加",
	});
	input.addEventListener("keydown", (e) => {
		if (e.isComposing || e.key !== "Enter") return;
		e.preventDefault();
		const add = input.value
			.split(/[,、]/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (!add.length) return;
		setTags(id, [...(state.byId.get(id)?.tags || []), ...add], true);
	});
	chips.append(input);
	if (focusInput) input.focus();
}

/* ---------- hydrate (media blobs) ---------- */

async function hydrate(card) {
	const id = card.dataset.id;
	const t = state.byId.get(id);
	if (!t || card.dataset.hydrated) return;
	card.dataset.hydrated = "1";

	const avatarUrls = [
		...new Set([...card.querySelectorAll("img.avatar")].map((img) => img.dataset.avatar).filter(Boolean)),
	];
	let mediaRows;
	let avatarRows;
	try {
		[mediaRows, avatarRows] = await Promise.all([
			db.getMedia(id),
			Promise.all(avatarUrls.map((u) => db.getAvatar(u))),
		]);
	} catch {
		mediaRows = [];
		avatarRows = [];
	}
	if (!card.isConnected) return;

	const urls = [];
	urlsByCard.set(id, urls);
	const objectUrl = (blob) => {
		const u = URL.createObjectURL(blob);
		urls.push(u);
		return u;
	};

	const avatarSrc = new Map();
	avatarUrls.forEach((u, i) => {
		const row = avatarRows[i];
		avatarSrc.set(u, row && row.blob ? objectUrl(row.blob) : safeHref(u));
	});
	for (const img of card.querySelectorAll("img.avatar")) {
		const src = avatarSrc.get(img.dataset.avatar);
		if (src) img.src = src;
	}

	const rows = new Map(mediaRows.map((m) => [m.key, m]));
	const metas = new Map([...(t.media || []), ...((t.quote && t.quote.media) || [])].map((m) => [m.key, m]));
	// ライトボックスの画像列と「X で見る」のリンク先は、本体と引用ツイートで分ける。
	const photosByOwner = { main: [], quote: [] };
	for (const slot of card.querySelectorAll(".m-item")) {
		const meta = metas.get(slot.dataset.key);
		if (!meta) continue;
		const owner = String(meta.key).split(":")[1] === "quote" && t.quote ? "quote" : "main";
		fillSlot(slot, meta, rows.get(meta.key), objectUrl, photosByOwner[owner], owner === "quote" ? t.quote : t);
	}
}

function missingMediaCount(t) {
	return [...(t.media || []), ...((t.quote && t.quote.media) || [])].filter(
		(m) => (!m.stored && m.url) || (m.type !== "photo" && !m.posterStored && m.posterUrl),
	).length;
}

function rebuildCard(id) {
	const old = cardOf(id);
	const t = state.byId.get(id);
	if (!old || !t) return;
	mediaObserver.unobserve(old);
	for (const u of urlsByCard.get(id) || []) URL.revokeObjectURL(u);
	urlsByCard.delete(id);
	old.replaceWith(buildCard(t));
}

// メディアの取得は twimg への host 権限を持つ background が行い、viewer は結果を DB から読み直す。
async function retryMedia(id, btn) {
	btn.disabled = true;
	btn.textContent = "再取得中…";
	try {
		const res = await chrome.runtime.sendMessage({ type: "retryMedia", id });
		if (!res || !res.ok) throw new Error((res && res.error) || "再取得に失敗しました");
		const r = await db.getTweet(id);
		if (r) {
			replaceTweet(r);
			rebuildCard(id);
		}
	} catch (err) {
		alert(err.message);
		btn.disabled = false;
		btn.textContent = `メディアを再取得 (${missingMediaCount(state.byId.get(id) || {})})`;
	}
}

function fillSlot(slot, meta, row, objectUrl, photos, t) {
	slot.textContent = "";
	const src = row && row.blob ? objectUrl(row.blob) : "";
	const poster = row && row.posterBlob ? objectUrl(row.posterBlob) : safeHref(meta.posterUrl);

	if (meta.type === "photo") {
		const url = src || safeHref(meta.url);
		if (!url) {
			slot.append(h("div", { class: "m-missing" }, "画像を取得できませんでした"));
			return;
		}
		const index = photos.push(url) - 1;
		const img = h("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
		img.addEventListener("click", () => openLightbox(photos, index));
		slot.append(img);
		if (!src) slot.append(h("span", { class: "m-badge" }, "未保存"));
		return;
	}

	const videoUrl = src || safeHref(meta.url);
	if (!videoUrl) {
		const href = safeHref(t.url);
		slot.append(
			h(
				"div",
				{
					class: "m-missing",
					style: poster ? { background: `center / cover no-repeat url("${poster}")` } : null,
				},
				h(
					"span",
					{
						style: {
							background: "rgba(0,0,0,.7)",
							color: "#fff",
							padding: "4px 10px",
							borderRadius: "8px",
						},
					},
					"動画は保存されていません ",
					href
						? h(
								"a",
								{ href, target: "_blank", rel: "noopener noreferrer", style: { color: "#8ecdf8" } },
								"X で見る",
							)
						: null,
				),
			),
		);
		return;
	}
	const video = document.createElement("video");
	video.src = videoUrl;
	if (poster) video.poster = poster;
	video.playsInline = true;
	video.preload = "metadata";
	if (meta.type === "gif") {
		video.muted = true;
		video.loop = true;
		video.autoplay = true;
	} else {
		video.controls = true;
	}
	slot.append(video);
	if (meta.type === "gif") slot.append(h("span", { class: "m-badge" }, "GIF"));
	else if (!src) slot.append(h("span", { class: "m-badge" }, "未保存"));
}

/* ---------- mutations ---------- */

async function moveTweet(id, folderId) {
	try {
		const r = await db.updateTweet(id, { folderId });
		replaceTweet(r);
		const select = cardOf(id)?.querySelector(".folder-select");
		if (select) select.value = r.folderId;
		renderSidebar();
		syncMembership(id);
	} catch (err) {
		alert(err.message);
	}
}

async function setTags(id, tags, focusInput) {
	try {
		const r = await db.updateTweet(id, { tags });
		replaceTweet(r);
		const chips = cardOf(id)?.querySelector(".chips");
		if (chips) renderChips(chips, id, focusInput);
		renderSidebar();
		syncMembership(id);
	} catch (err) {
		alert(err.message);
	}
}

async function removeTweet(id) {
	if (!confirm("このツイートを Vault から削除しますか？\n保存したメディアも削除されます。")) return;
	try {
		await db.deleteTweet(id);
		state.tweets = state.tweets.filter((t) => t.id !== id);
		state.byId.delete(id);
		dropCard(id);
		renderSidebar();
		updateSummary();
	} catch (err) {
		alert(err.message);
	}
}

/* ---------- lightbox ---------- */

const lb = { list: [], index: 0 };

function openLightbox(list, index) {
	lb.list = list;
	lb.index = index;
	showLightbox();
	els.lightbox.hidden = false;
}

function showLightbox() {
	els.lbImg.src = lb.list[lb.index] || "";
	const multi = lb.list.length > 1;
	els.lightbox.querySelector(".prev").hidden = !multi;
	els.lightbox.querySelector(".next").hidden = !multi;
}

function stepLightbox(d) {
	if (lb.list.length < 2) return;
	lb.index = (lb.index + d + lb.list.length) % lb.list.length;
	showLightbox();
}

function closeLightbox() {
	els.lightbox.hidden = true;
	els.lbImg.removeAttribute("src");
}

els.lightbox.addEventListener("click", (e) => {
	const act = e.target.closest("[data-lb]")?.dataset.lb;
	if (act === "prev") stepLightbox(-1);
	else if (act === "next") stepLightbox(1);
	else if (act === "close" || e.target === els.lightbox) closeLightbox();
});

document.addEventListener("keydown", (e) => {
	if (els.lightbox.hidden) return;
	if (e.key === "Escape") closeLightbox();
	else if (e.key === "ArrowLeft") stepLightbox(-1);
	else if (e.key === "ArrowRight") stepLightbox(1);
});

/* ---------- export / import ---------- */

function progress(text) {
	els.ioProgress.textContent = text;
}

function setBusy(busy) {
	for (const b of els.settings.querySelectorAll("#exportFull, #exportMeta, #importFile")) b.disabled = busy;
}

function blobToDataUrl(blob) {
	if (!blob) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result);
		r.onerror = () => reject(r.error);
		r.readAsDataURL(blob);
	});
}

function dataUrlToBlob(s) {
	if (typeof s !== "string" || !s.startsWith("data:")) return null;
	const comma = s.indexOf(",");
	const head = s.slice(5, comma);
	const mime = head.split(";")[0] || "application/octet-stream";
	const bin = atob(s.slice(comma + 1));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}

function downloadBlob(blob, name) {
	const url = URL.createObjectURL(blob);
	const a = h("a", { href: url, download: name });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/*
 * バックアップ形式は 1 行 1 レコードの JSON Lines とする。
 *   1 行目: { kind: 'header', format: 'tweet-vault', version, exportedAt, withMedia }
 *   2 行目: { kind: 'meta', folders: [...], tweets: [...] }
 *   以降  : { kind: 'media', ...mediaRecord (blob は data URL) } / { kind: 'avatar', url, blob }
 * 単一 JSON にすると読み込み時にファイル全体が 1 つの文字列となり、
 * V8 の文字列長上限 (約 512MB) を超えるバックアップを復元できないため、行単位で読み書きする。
 */
const BACKUP_FORMAT = "tweet-vault";
const BACKUP_VERSION = 2;

/*
 * 書き出し先。showSaveFilePicker が使える場合はファイルへ 1 行ずつ書き込み、
 * 書き出し済みの行をメモリに保持しない。使えない場合は Blob を連結してダウンロードする。
 * showSaveFilePicker はユーザー操作直後でないと失敗するため、DB の読み込みより先に呼ぶ。
 */
async function openSink(name) {
	if (typeof window.showSaveFilePicker === "function") {
		let handle;
		try {
			handle = await window.showSaveFilePicker({
				suggestedName: name,
				types: [{ description: "Tweet Vault バックアップ", accept: { "application/x-ndjson": [".jsonl"] } }],
			});
		} catch (err) {
			if (err && err.name === "AbortError") return null;
			throw err;
		}
		const writable = await handle.createWritable();
		return {
			write: (text) => writable.write(text),
			close: () => writable.close(),
			abort: () => writable.abort().catch(() => {}),
		};
	}
	const parts = [];
	return {
		write: async (text) => {
			parts.push(new Blob([text]));
		},
		close: async () => downloadBlob(new Blob(parts, { type: "application/x-ndjson" }), name),
		abort: async () => {
			parts.length = 0;
		},
	};
}

async function exportData(withMedia) {
	const stamp = new Date().toISOString().slice(0, 10);
	let sink;
	try {
		sink = await openSink(`tweet-vault-${stamp}${withMedia ? "" : "-meta"}.jsonl`);
	} catch (err) {
		progress(`書き出しに失敗しました: ${err.message}`);
		return;
	}
	if (!sink) return;
	setBusy(true);
	progress("書き出しを準備中…");
	try {
		const [tweets, folders] = await Promise.all([db.getAll("tweets"), db.getAll("folders")]);
		await sink.write(
			`${JSON.stringify({ kind: "header", format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), withMedia })}\n`,
		);
		await sink.write(`${JSON.stringify({ kind: "meta", folders, tweets })}\n`);
		if (withMedia) {
			for (let i = 0; i < tweets.length; i++) {
				for (const m of await db.getMedia(tweets[i].id)) {
					const row = {
						kind: "media",
						...m,
						blob: await blobToDataUrl(m.blob),
						posterBlob: await blobToDataUrl(m.posterBlob),
					};
					await sink.write(`${JSON.stringify(row)}\n`);
				}
				if (i % 10 === 0) progress(`メディアを書き出し中… ${i + 1} / ${tweets.length}`);
			}
			for (const a of await db.getAll("avatars")) {
				await sink.write(
					`${JSON.stringify({ kind: "avatar", url: a.url, blob: await blobToDataUrl(a.blob) })}\n`,
				);
			}
		}
		await sink.close();
		progress(`${tweets.length.toLocaleString()} 件を書き出しました`);
	} catch (err) {
		await sink.abort();
		progress(`書き出しに失敗しました: ${err.message}`);
	} finally {
		setBusy(false);
	}
}

// File をストリームで読み、改行区切りの行を順に返す。走査は直前の読み込み位置から再開する。
async function* readLines(file) {
	const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		let from = buf.length;
		buf += value;
		let i;
		while ((i = buf.indexOf("\n", from)) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			from = 0;
			if (line.trim()) yield line;
		}
	}
	if (buf.trim()) yield buf;
}

async function importMeta(meta) {
	const folders = (Array.isArray(meta.folders) ? meta.folders : [])
		.filter((f) => f && typeof f.id === "string" && typeof f.name === "string" && f.name.trim())
		.map((f) => ({ id: f.id, name: f.name.trim().slice(0, 60), createdAt: Number(f.createdAt) || 0 }));
	await db.bulkPut("folders", folders);
	const folderIds = new Set((await db.listFolders()).map((f) => f.id));
	const tweets = (Array.isArray(meta.tweets) ? meta.tweets : [])
		.filter((t) => t && typeof t.id === "string" && /^\d+$/.test(t.id))
		.map((t) => ({
			...t,
			folderId: folderIds.has(t.folderId) ? t.folderId : db.DEFAULT_FOLDER_ID,
			tags: db.normalizeTags(t.tags),
			media: Array.isArray(t.media) ? t.media : [],
			savedAt: Number(t.savedAt) || Date.now(),
			updatedAt: Date.now(),
		}));
	await db.bulkPut("tweets", tweets);
	return tweets.length;
}

async function importData(file) {
	setBusy(true);
	progress("読み込み中…");
	let tweetCount = 0;
	let mediaCount = 0;
	let media = [];
	let avatars = [];
	const flush = async () => {
		if (media.length) await db.bulkPut("media", media);
		if (avatars.length) await db.bulkPut("avatars", avatars);
		mediaCount += media.length;
		media = [];
		avatars = [];
		progress(`メディアを読み込み中… ${mediaCount.toLocaleString()} 件`);
	};
	try {
		let lineNo = 0;
		for await (const line of readLines(file)) {
			const row = JSON.parse(line);
			if (lineNo++ === 0) {
				if (!row || row.kind !== "header" || row.format !== BACKUP_FORMAT) {
					throw new Error("Tweet Vault のバックアップファイルではありません");
				}
				continue;
			}
			if (row.kind === "meta") {
				tweetCount += await importMeta(row);
			} else if (row.kind === "media" && typeof row.key === "string" && typeof row.tweetId === "string") {
				const { kind, ...rest } = row;
				media.push({ ...rest, blob: dataUrlToBlob(row.blob), posterBlob: dataUrlToBlob(row.posterBlob) });
			} else if (row.kind === "avatar" && typeof row.url === "string") {
				const blob = dataUrlToBlob(row.blob);
				if (blob) avatars.push({ url: row.url, blob });
			}
			if (media.length + avatars.length >= 20) await flush();
		}
		if (lineNo === 0) throw new Error("ファイルが空です");
		await flush();
		progress(
			`${tweetCount.toLocaleString()} 件のツイートと ${mediaCount.toLocaleString()} 件のメディアを読み込みました`,
		);
	} catch (err) {
		// 途中で失敗しても、それまでに書き込んだ行は DB に残るため件数を併記する。
		const partial =
			tweetCount || mediaCount
				? ` (${tweetCount.toLocaleString()} 件のツイートと ${mediaCount.toLocaleString()} 件のメディアは読み込み済み)`
				: "";
		progress(`読み込みに失敗しました${partial}: ${err.message}`);
	} finally {
		setBusy(false);
		els.importFile.value = "";
		// 成否に関わらず、一覧を DB の現在の内容に合わせる。
		await reload().catch(() => {});
	}
}

/* ---------- wiring ---------- */

function applyLayout() {
	els.grid.classList.toggle("list", state.layout === "list");
	relayout();
	for (const b of document.querySelectorAll("[data-layout]"))
		b.classList.toggle("on", b.dataset.layout === state.layout);
}

function bindUi() {
	let qTimer = 0;
	els.q.addEventListener("input", () => {
		clearTimeout(qTimer);
		qTimer = setTimeout(() => {
			state.q = els.q.value.trim();
			applyFilter();
		}, 150);
	});

	els.sort.value = state.sort in SORTS ? state.sort : "saved-desc";
	els.sort.addEventListener("change", () => {
		state.sort = els.sort.value;
		savePrefs();
		applyFilter();
	});

	for (const b of document.querySelectorAll("[data-layout]")) {
		b.addEventListener("click", () => {
			state.layout = b.dataset.layout;
			savePrefs();
			applyLayout();
		});
	}
	applyLayout();

	els.newFolderForm.addEventListener("submit", async (e) => {
		e.preventDefault();
		const name = els.newFolderName.value.trim();
		if (!name) return;
		try {
			const f = await db.createFolder(name);
			els.newFolderName.value = "";
			state.folders = await db.listFolders();
			refreshFolderSelects();
			state.folder = f.id;
			renderSidebar();
			applyFilter();
		} catch (err) {
			alert(err.message);
		}
	});

	$("#menuBtn").addEventListener("click", () => els.side.classList.toggle("open"));
	$("#bannerReload").addEventListener("click", () => reload());

	$("#openSettings").addEventListener("click", async () => {
		const { hideNativeBookmark } = await chrome.storage.local.get({ hideNativeBookmark: true });
		els.hideNative.checked = hideNativeBookmark;
		progress("");
		els.settings.showModal();
	});
	els.hideNative.addEventListener("change", () =>
		chrome.storage.local.set({ hideNativeBookmark: els.hideNative.checked }),
	);
	$("#exportFull").addEventListener("click", () => exportData(true));
	$("#exportMeta").addEventListener("click", () => exportData(false));
	els.importFile.addEventListener("change", () => {
		const f = els.importFile.files && els.importFile.files[0];
		if (f) importData(f);
	});

	// background は保存・更新のたびに通知する。表示中の一覧を勝手に並べ替えないよう、再読み込みはバナー経由とする。
	chrome.runtime.onMessage.addListener((msg) => {
		if (msg && msg.type === "tvault:changed") els.banner.hidden = false;
	});
}

async function init() {
	loadPrefs();
	bindUi();
	try {
		await navigator.storage.persist();
	} catch {
		/* unlimitedStorage 権限下では未対応でも動作に影響しない */
	}
	await reload();
}

init().catch((err) => {
	els.empty.hidden = false;
	els.empty.textContent = `読み込みに失敗しました: ${err.message}`;
});
