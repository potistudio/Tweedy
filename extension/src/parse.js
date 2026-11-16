/*
 * X の API レスポンスを拡張機能内部の正規化ツイート形式へ変換する。
 *
 * このファイルは ES module の import/export を持たない classic script として記述する。
 * content script (MAIN / ISOLATED world) からは manifest 経由で、
 * background (module service worker) からは副作用 import で読み込まれ、
 * いずれも globalThis.TVaultParse を参照する。
 *
 * 正規化ツイート形式:
 * {
 *   id: string, url: string, text: string, createdAt: string (ISO 8601) | '',
 *   lang: string,
 *   author: { name: string, screenName: string, avatarUrl: string },
 *   media: Array<{ type: 'photo'|'video'|'gif', url: string, posterUrl: string, width: number, height: number }>,
 *   quote: 正規化ツイート (quote は常に null) | null,
 *   source: 'graphql' | 'syndication' | 'dom'
 * }
 */
(function (root) {
	"use strict";

	const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
	const ENTITY_RE = /&(amp|lt|gt|quot|#39);/g;

	function decodeEntities(s) {
		return String(s || "").replace(ENTITY_RE, (_, k) => ENTITY_MAP[k]);
	}

	// _normal は 48px のため、一覧表示用に 73px の _bigger へ置き換える。
	function avatarUrl(url) {
		if (!url) return "";
		return String(url).replace(/_normal(\.\w+)?$/, (_, ext) => `_bigger${ext || ""}`);
	}

	// pbs.twimg.com/media の画像を原寸 (name=orig) で取得する URL へ変換する。
	// 拡張子付きパス (xxx.jpg) と format クエリ形式 (xxx?format=jpg) の両方を format クエリ形式へ揃える。
	function photoUrl(url) {
		if (!url) return "";
		try {
			const u = new URL(url);
			if (u.hostname !== "pbs.twimg.com") return url;
			const m = u.pathname.match(/^(.*)\.(jpg|jpeg|png|webp|gif)$/i);
			if (m) {
				u.pathname = m[1];
				const ext = m[2].toLowerCase();
				u.searchParams.set("format", ext === "jpeg" ? "jpg" : ext);
			}
			u.searchParams.set("name", "orig");
			return u.toString();
		} catch {
			return url;
		}
	}

	function bestVideoUrl(variants) {
		const mp4 = (variants || []).filter((v) => v && v.url && v.content_type === "video/mp4");
		mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
		return mp4.length ? mp4[0].url : "";
	}

	function toIso(value) {
		if (!value) return "";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "" : d.toISOString();
	}

	function toMedia(m) {
		if (!m || typeof m !== "object") return null;
		const base = m.media_url_https || m.media_url || "";
		const width = (m.original_info && m.original_info.width) || (m.sizes && m.sizes.large && m.sizes.large.w) || 0;
		const height =
			(m.original_info && m.original_info.height) || (m.sizes && m.sizes.large && m.sizes.large.h) || 0;
		if (m.type === "photo") {
			return { type: "photo", url: photoUrl(base), posterUrl: "", width, height };
		}
		if (m.type === "video" || m.type === "animated_gif") {
			return {
				type: m.type === "video" ? "video" : "gif",
				url: bestVideoUrl(m.video_info && m.video_info.variants),
				posterUrl: base,
				width,
				height,
			};
		}
		return null;
	}

	function statusIdOf(url) {
		const m = /\/status(?:es)?\/(\d+)/.exec(url || "");
		return m ? m[1] : "";
	}

	// ツイート ID (snowflake) の上位ビットに含まれる投稿時刻を ISO 8601 で返す。snowflake 以前の ID は空文字を返す。
	const SNOWFLAKE_EPOCH = 1288834974657n;
	function timeFromId(id) {
		try {
			const ms = (BigInt(id) >> 22n) + SNOWFLAKE_EPOCH;
			// 2010-11 以前の ID は連番であり時刻を含まないため除外する。
			if (ms < 1288834974657n + 86400000n) return "";
			return new Date(Number(ms)).toISOString();
		} catch {
			return "";
		}
	}

	const TCO_RE = /^https?:\/\/t\.co\/\w+$/;

	/*
	 * メディア添付を指す t.co URL の集合を返す。
	 * 旧スキーマはメディアの url から、新スキーマ (media_entities2) は indices が指す範囲から特定する。
	 * indices は details.full_text / legacy.full_text の位置を指すため、sourceText には必ずそれらを渡す。
	 */
	function mediaTcoUrls(sourceText, mediaList) {
		const drop = new Set();
		let codePoints = null;
		for (const m of mediaList || []) {
			if (!m) continue;
			if (m.url && TCO_RE.test(m.url)) {
				drop.add(m.url);
			} else if (Array.isArray(m.indices) && m.indices.length === 2) {
				codePoints = codePoints || Array.from(String(sourceText || ""));
				const seg = codePoints.slice(m.indices[0], m.indices[1]).join("");
				if (TCO_RE.test(seg)) drop.add(seg);
			}
		}
		return drop;
	}

	/*
	 * 本文中の t.co 短縮 URL を展開する。
	 * - mediaUrls に含まれるメディア添付の t.co URL は本文に表示しないため削除する。
	 * - 引用ツイートの permalink は quote として別に保持するため削除する。
	 */
	// 本文の途中にある URL を削除した箇所に空白が連続して残らないよう、直前の空白も合わせて削除する。
	function removeToken(text, token) {
		return text.replace(new RegExp(`[ \\t]*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), "");
	}

	function expandText(raw, urls, mediaUrls, quoteId) {
		let text = String(raw || "");
		for (const u of mediaUrls) text = removeToken(text, u);
		for (const u of urls || []) {
			if (!u || !u.url) continue;
			const expanded = u.expanded_url || u.url;
			const drop = quoteId && statusIdOf(expanded) === quoteId;
			text = drop ? removeToken(text, u.url) : text.split(u.url).join(expanded);
		}
		return decodeEntities(text).trim();
	}

	/*
	 * GraphQL のツイートオブジェクトを変換する。次の 2 種類のスキーマに対応する。
	 *   旧: legacy.full_text / legacy.created_at / legacy.extended_entities.media / legacy.entities.urls / quoted_status_result
	 *   新: details.full_text / details.created_at_ms / media_entities2 / url_entities / quoted_tweet_results
	 */
	function fromGraphql(node, depth) {
		depth = depth || 0;
		let r = node;
		if (r && r.__typename === "TweetWithVisibilityResults" && r.tweet) r = r.tweet;
		if (!r || !r.rest_id) return null;
		const L = r.legacy || {};
		const D = r.details || {};
		const fullText = typeof D.full_text === "string" ? D.full_text : L.full_text;
		if (typeof fullText !== "string") return null;
		const u = (r.core && r.core.user_results && r.core.user_results.result) || {};
		const uc = u.core || {};
		const ul = u.legacy || {};
		const screenName = uc.screen_name || ul.screen_name || "";
		const author = {
			name: uc.name || ul.name || screenName,
			screenName,
			avatarUrl: avatarUrl((u.avatar && u.avatar.image_url) || ul.profile_image_url_https || ""),
		};

		const quoteWrap = depth === 0 ? r.quoted_tweet_results || r.quoted_status_result : null;
		const quote = quoteWrap && quoteWrap.result ? fromGraphql(quoteWrap.result, depth + 1) : null;
		const quoteId = (quote && quote.id) || (quoteWrap && quoteWrap.rest_id) || L.quoted_status_id_str || "";

		const mediaList =
			(Array.isArray(r.media_entities2) && r.media_entities2.length && r.media_entities2) ||
			(L.extended_entities && L.extended_entities.media) ||
			(L.entities && L.entities.media && L.entities.media.some((m) => m && m.type) && L.entities.media) ||
			[];
		const urls =
			(Array.isArray(r.url_entities) && r.url_entities.length && r.url_entities) ||
			(L.entities && L.entities.urls) ||
			[];
		const note = r.note_tweet && r.note_tweet.note_tweet_results && r.note_tweet.note_tweet_results.result;
		const mediaUrls = mediaTcoUrls(fullText, mediaList);
		const text =
			note && note.text
				? expandText(note.text, note.entity_set && note.entity_set.urls, mediaUrls, quoteId)
				: expandText(fullText, urls, mediaUrls, quoteId);

		let createdAt = "";
		if (Number.isFinite(D.created_at_ms)) createdAt = new Date(D.created_at_ms).toISOString();
		else createdAt = toIso(L.created_at) || timeFromId(r.rest_id);

		return {
			id: String(r.rest_id),
			url: `https://x.com/${screenName || "i"}/status/${r.rest_id}`,
			text,
			createdAt,
			lang: L.lang || "",
			author,
			media: mediaList.map(toMedia).filter(Boolean),
			quote,
			source: "graphql",
		};
	}

	function isTweetNode(n) {
		if (!n.rest_id) return false;
		if (n.details && typeof n.details.full_text === "string") return true;
		return !!n.legacy && typeof n.legacy.full_text === "string";
	}

	/*
	 * GraphQL レスポンス全体を走査し、ツイートオブジェクトを全て抽出する。
	 * タイムライン・詳細・検索などエンドポイントごとにネスト構造が異なるため、
	 * パスを固定せず rest_id と本文 (details.full_text または legacy.full_text) を持つノードをツイートとして扱う。
	 * 再帰呼び出しの代わりに明示的なスタックを使い、深いネストでのスタック溢れを防ぐ。
	 */
	function collectFromGraphql(json) {
		const out = [];
		const seen = new Set();
		const stack = [json];
		let visited = 0;
		while (stack.length && visited++ < 500000) {
			const n = stack.pop();
			if (!n || typeof n !== "object") continue;
			if (Array.isArray(n)) {
				for (let i = n.length - 1; i >= 0; i--) {
					if (n[i] && typeof n[i] === "object") stack.push(n[i]);
				}
				continue;
			}
			if (isTweetNode(n) && !seen.has(String(n.rest_id))) {
				const t = fromGraphql(n, 0);
				if (t) {
					seen.add(t.id);
					out.push(t);
				}
			}
			for (const k in n) {
				const v = n[k];
				if (v && typeof v === "object") stack.push(v);
			}
		}
		return out;
	}

	/*
	 * サーバーレンダリングされた HTML の <script> に埋め込まれた GraphQL 結果を抽出する。
	 * 結果は JS の文字列リテラル "{\"data\":...}" として埋め込まれるため、
	 * リテラルの終端を走査で特定し、文字列としてデコードした後に JSON として解析する。
	 */
	const EMBED_MARK = '"{\\"data\\":';

	function decodeJsStringLiteral(lit) {
		// JSON が受け付けない \xHH を \u00HH へ置換する。\\ を先に消費し、エスケープされたバックスラッシュを誤変換しない。
		return JSON.parse(lit.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (m, _a, hex) => (hex ? `\\u00${hex}` : m)));
	}

	// 1 つのスクリプトに複数の結果が埋め込まれ同じツイートが重複する場合があるため、ID で重複を除く。
	function collectFromScriptText(src) {
		const byId = new Map();
		const text = String(src || "");
		let from = 0;
		for (;;) {
			const start = text.indexOf(EMBED_MARK, from);
			if (start < 0) break;
			let i = start + 1;
			while (i < text.length) {
				const c = text.charCodeAt(i);
				if (c === 92) {
					i += 2;
					continue;
				}
				if (c === 34) break;
				i++;
			}
			from = i + 1;
			try {
				for (const t of collectFromGraphql(JSON.parse(decodeJsStringLiteral(text.slice(start, i + 1))))) {
					if (!byId.has(t.id)) byId.set(t.id, t);
				}
			} catch {
				/* 解析できない断片は無視する */
			}
		}
		return [...byId.values()];
	}

	// cdn.syndication.twimg.com/tweet-result のレスポンスを変換する。
	function fromSyndication(j, depth) {
		depth = depth || 0;
		if (!j || !j.id_str || j.__typename === "TweetTombstone") return null;
		const user = j.user || {};
		const screenName = user.screen_name || "";
		const quote = depth === 0 && j.quoted_tweet ? fromSyndication(j.quoted_tweet, depth + 1) : null;
		const quoteId = (quote && quote.id) || j.quoted_tweet_id_str || "";
		const mediaDetails = j.mediaDetails || [];
		const mediaUrls = mediaTcoUrls(j.text, mediaDetails.concat((j.entities && j.entities.media) || []));
		const note = j.note_tweet && j.note_tweet.note_tweet_results && j.note_tweet.note_tweet_results.result;
		const text =
			note && note.text
				? expandText(note.text, note.entity_set && note.entity_set.urls, mediaUrls, quoteId)
				: expandText(j.text, j.entities && j.entities.urls, mediaUrls, quoteId);
		return {
			id: String(j.id_str),
			url: `https://x.com/${screenName || "i"}/status/${j.id_str}`,
			text,
			createdAt: toIso(j.created_at) || timeFromId(j.id_str),
			lang: j.lang || "",
			author: {
				name: user.name || screenName,
				screenName,
				avatarUrl: avatarUrl(user.profile_image_url_https || ""),
			},
			media: mediaDetails.map(toMedia).filter(Boolean),
			quote,
			source: "syndication",
		};
	}

	root.TVaultParse = {
		avatarUrl,
		photoUrl,
		bestVideoUrl,
		decodeEntities,
		timeFromId,
		fromGraphql,
		collectFromGraphql,
		collectFromScriptText,
		fromSyndication,
	};
})(globalThis);
