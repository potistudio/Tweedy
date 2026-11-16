/*
 * Service worker。content script からのメッセージを受け、
 * メディアのダウンロードと IndexedDB への書き込みを担当する。
 * IndexedDB は拡張機能オリジンに属するため、x.com 側の content script からは直接書き込まない。
 */
import "./parse.js";
import * as db from "./db.js";

const P = globalThis.TVaultParse;
const MEDIA_HOST_RE = /(^|\.)twimg\.com$/;
const MAX_TEXT = 20000;
const MAX_MEDIA = 10;

// 同一ツイートの保存処理を直列化する。updateTweet / deleteTweet は保存完了を待ってから実行する。
const pending = new Map();

chrome.action.onClicked.addListener(() => {
	openViewer().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	const handler =
		msg && typeof msg.type === "string" && Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
	if (!handler) return false;
	Promise.resolve()
		.then(() => handler(msg, sender))
		.then(
			(data) => sendResponse({ ok: true, data }),
			(err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
		);
	return true;
});

const handlers = {
	getStatus({ ids }) {
		const list = (Array.isArray(ids) ? ids : [])
			.map(String)
			.filter((id) => /^\d+$/.test(id))
			.slice(0, 500);
		return db.getStatuses(list);
	},

	async saveTweet({ tweet, folderId, tags }) {
		const t = sanitizeTweet(tweet, 0);
		if (!t) throw new Error("ツイートデータが不正です");
		if (pending.has(t.id)) return pending.get(t.id);
		const job = (async () => {
			const existing = await db.getTweet(t.id);
			if (existing) return { ...summary(existing), existed: true };
			const { record, media, avatars } = await download(t);
			const now = Date.now();
			Object.assign(record, {
				folderId: typeof folderId === "string" ? folderId : db.DEFAULT_FOLDER_ID,
				tags: Array.isArray(tags) ? tags : [],
				savedAt: now,
				updatedAt: now,
			});
			const saved = await db.putTweetBundle(record, media, avatars);
			notifyChanged();
			return summary(saved);
		})();
		pending.set(t.id, job);
		try {
			return await job;
		} finally {
			pending.delete(t.id);
		}
	},

	async updateTweet({ id, folderId, tags }) {
		id = String(id);
		await settle(id);
		const patch = {};
		if (typeof folderId === "string") patch.folderId = folderId;
		if (Array.isArray(tags)) patch.tags = tags;
		const r = await db.updateTweet(id, patch);
		notifyChanged();
		return summary(r);
	},

	async deleteTweet({ id }) {
		id = String(id);
		await settle(id);
		await db.deleteTweet(id);
		notifyChanged();
		return true;
	},

	// 保存時に取得できなかったメディア・サムネイルを、記録済みの URL から再取得する。
	// 呼び出し元の viewer が自身で再描画するため、変更通知は送らない。
	async retryMedia({ id }) {
		id = String(id);
		await settle(id);
		const r = await db.getTweet(id);
		if (!r) throw new Error("ツイートが見つかりません");
		// key を持たない、または他ツイートの key を持つメタデータは対象外とする。
		const metas = [...(r.media || []), ...((r.quote && r.quote.media) || [])].filter(
			(m) => m && typeof m.key === "string" && m.key.startsWith(`${id}:`),
		);
		const patches = (
			await Promise.all(
				metas.map(async (m) => {
					const needBlob = !m.stored && m.url;
					const needPoster = m.type !== "photo" && !m.posterStored && m.posterUrl;
					if (!needBlob && !needPoster) return null;
					const [blob, posterBlob] = await Promise.all([
						needBlob ? (m.type === "photo" ? fetchPhoto(m.url) : fetchBlob(m.url)) : null,
						needPoster ? fetchBlob(m.posterUrl) : null,
					]);
					if (!blob && !posterBlob) return null;
					const [, owner, index] = String(m.key).split(":");
					return {
						key: m.key,
						owner,
						index: Number(index) || 0,
						type: m.type,
						url: m.url,
						posterUrl: m.posterUrl,
						blob,
						posterBlob,
					};
				}),
			)
		).filter(Boolean);
		const updated = patches.length ? await db.patchMedia(id, patches) : r;
		return summary(updated);
	},

	listFolders: () => db.listFolders(),

	async createFolder({ name }) {
		const f = await db.createFolder(name);
		notifyChanged();
		return f;
	},

	listTags: () => db.listTags(),

	fetchSyndication: ({ id }) => fetchSyndication(String(id)),

	openViewer: () => openViewer(),
};

async function settle(id) {
	const job = pending.get(id);
	if (job) await job.catch(() => {});
}

function summary(r) {
	const all = [...(r.media || []), ...((r.quote && r.quote.media) || [])];
	return {
		id: r.id,
		folderId: r.folderId,
		tags: r.tags,
		mediaCount: all.length,
		mediaFailed: all.filter((m) => !m.stored).length,
	};
}

function notifyChanged() {
	chrome.runtime.sendMessage({ type: "tvault:changed" }).catch(() => {});
}

async function openViewer() {
	const url = chrome.runtime.getURL("viewer.html");
	try {
		const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
		const ctx = contexts.find((c) => c.tabId >= 0);
		if (ctx) {
			await chrome.tabs.update(ctx.tabId, { active: true });
			if (ctx.windowId >= 0) await chrome.windows.update(ctx.windowId, { focused: true });
			return;
		}
	} catch {
		/* getContexts 非対応時は新規タブを開く */
	}
	await chrome.tabs.create({ url });
}

/* ---------- 入力の検証 ---------- */

// content script 経由のデータはページ側から偽装され得るため、既知のフィールドのみを型を揃えて複製する。
function str(v, max) {
	return typeof v === "string" ? v.slice(0, max) : "";
}

function num(v) {
	return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function sanitizeTweet(t, depth) {
	if (!t || typeof t !== "object") return null;
	const id = String(t.id || "");
	if (!/^\d{1,25}$/.test(id)) return null;
	const a = t.author && typeof t.author === "object" ? t.author : {};
	const media = (Array.isArray(t.media) ? t.media : []).slice(0, MAX_MEDIA).map((m) => ({
		type: ["photo", "video", "gif"].includes(m && m.type) ? m.type : "photo",
		url: str(m && m.url, 2048),
		posterUrl: str(m && m.posterUrl, 2048),
		width: num(m && m.width),
		height: num(m && m.height),
	}));
	return {
		id,
		url: /^https:\/\/(x|twitter)\.com\//.test(t.url || "") ? str(t.url, 512) : `https://x.com/i/status/${id}`,
		text: str(t.text, MAX_TEXT),
		createdAt: str(t.createdAt, 64),
		lang: str(t.lang, 16),
		author: {
			name: str(a.name, 200),
			screenName: str(a.screenName, 100),
			avatarUrl: str(a.avatarUrl, 2048),
		},
		media,
		quote: depth === 0 ? sanitizeTweet(t.quote, 1) : null,
		source: ["graphql", "syndication", "dom"].includes(t.source) ? t.source : "dom",
	};
}

/* ---------- ダウンロード ---------- */

// 応答が停止した接続で保存処理が完了しない状態を防ぐため、本文の受信完了までを含めて打ち切る。
const MEDIA_TIMEOUT_MS = 180_000;
const SYNDICATION_TIMEOUT_MS = 10_000;

async function fetchBlob(url) {
	if (!url) return null;
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" || !MEDIA_HOST_RE.test(u.hostname)) return null;
	try {
		const res = await fetch(u.toString(), { credentials: "omit", signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
		if (!res.ok) return null;
		const blob = await res.blob();
		return blob.size ? blob : null;
	} catch {
		return null;
	}
}

// name=orig が提供されない画像があるため、失敗時は name=large で再取得する。
async function fetchPhoto(url) {
	const blob = await fetchBlob(url);
	if (blob || !url || !url.includes("name=orig")) return blob;
	return fetchBlob(url.replace("name=orig", "name=large"));
}

async function download(t) {
	const mediaRecords = [];

	const fetchMedia = (items, owner) =>
		Promise.all(
			items.map(async (m, index) => {
				const key = `${t.id}:${owner}:${index}`;
				const [blob, posterBlob] = await Promise.all([
					m.type === "photo" ? fetchPhoto(m.url) : fetchBlob(m.url),
					m.type === "photo" ? null : fetchBlob(m.posterUrl),
				]);
				mediaRecords.push({
					key,
					tweetId: t.id,
					owner,
					index,
					type: m.type,
					url: m.url,
					posterUrl: m.posterUrl,
					blob,
					posterBlob,
				});
				return { ...m, key, stored: !!blob, posterStored: !!posterBlob };
			}),
		);

	const avatarUrls = [...new Set([t.author.avatarUrl, t.quote && t.quote.author.avatarUrl].filter(Boolean))];

	const [mainMeta, quoteMeta, avatars] = await Promise.all([
		fetchMedia(t.media, "main"),
		t.quote ? fetchMedia(t.quote.media, "quote") : Promise.resolve([]),
		Promise.all(
			avatarUrls.map(async (url) => {
				if (await db.hasAvatar(url)) return null;
				const blob = await fetchBlob(url);
				return blob ? { url, blob } : null;
			}),
		),
	]);

	const record = {
		...t,
		media: mainMeta,
		quote: t.quote ? { ...t.quote, media: quoteMeta } : null,
	};
	return { record, media: mediaRecords, avatars: avatars.filter(Boolean) };
}

/* ---------- syndication API ---------- */

// cdn.syndication.twimg.com が要求する token をツイート ID から算出する。
function syndicationToken(id) {
	return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function fetchSyndication(id) {
	if (!/^\d+$/.test(id)) return null;
	const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=ja&token=${syndicationToken(id)}`;
	try {
		const res = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(SYNDICATION_TIMEOUT_MS) });
		if (!res.ok) return null;
		return P.fromSyndication(await res.json(), 0);
	} catch {
		return null;
	}
}
