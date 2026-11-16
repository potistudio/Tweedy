/*
 * ISOLATED world の content script。
 * - inject.js から postMessage で届くツイートをキャッシュする。
 * - 各ツイートのアクションバーに保存ボタンを挿入し、保存状態を表示する。
 * - 保存・フォルダ変更・タグ編集のポップオーバーを Shadow DOM 内に描画する。
 * DB への読み書きは全て background へのメッセージ経由で行う。
 */
(() => {
	if (window.__tvaultContent) return;
	window.__tvaultContent = true;

	/*
	 * Chrome は同一ファイルを複数の content_scripts エントリに列挙した場合、2 つ目以降の注入を省略する。
	 * parse.js は MAIN world 側のエントリで注入されるため、ISOLATED world では動的 import で読み込む。
	 * P を参照する処理 (fromDom) は loadParse() の解決後にのみ呼び出す。
	 */
	let P = globalThis.TVaultParse || null;
	let parseLoading = null;
	// 読み込みに失敗した場合は次回呼び出しで再試行する。
	function loadParse() {
		if (P) return Promise.resolve(P);
		if (!parseLoading) {
			parseLoading = import(chrome.runtime.getURL("src/parse.js"))
				.then(() => {
					P = globalThis.TVaultParse;
					if (!P) throw new Error("parse.js を読み込めませんでした");
					return P;
				})
				.catch((err) => {
					parseLoading = null;
					throw err;
				});
		}
		return parseLoading;
	}
	// 失敗は保存時の DOM 解析で再試行するため、ここでは診断用に記録するのみとする。
	loadParse().catch((err) => console.warn("[Tweet Vault] parse.js の読み込みに失敗しました", err));

	const CACHE_MAX = 4000;
	const BTN_CLASS = "tvault-btn";

	const ICON_OUTLINE =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3.5" width="18" height="5.5" rx="1.2"/><path d="M4.8 9v9.8c0 .9.7 1.7 1.7 1.7h11c.9 0 1.7-.8 1.7-1.7V9"/><path d="M9.8 13h4.4"/></svg>';
	const ICON_SAVED =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3.5" width="18" height="5.5" rx="1.2" fill="currentColor"/><path d="M4.8 10.2h14.4v8.6c0 .9-.8 1.7-1.7 1.7h-11c-1 0-1.7-.8-1.7-1.7z" fill="currentColor"/><path d="M9 14.9l2.1 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	/* ---------- ツイートキャッシュ ---------- */

	const cache = new Map();

	window.addEventListener("message", (e) => {
		if (e.source !== window) return;
		const d = e.data;
		if (!d || d.__tvault !== "tweets" || !Array.isArray(d.tweets)) return;
		for (const t of d.tweets) {
			if (!t || typeof t.id !== "string") continue;
			cache.delete(t.id);
			cache.set(t.id, t);
		}
		while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
		// getTweetId は引用関係の判定にキャッシュを使うため、キャッシュ更新後にボタンの ID を再判定する。
		queueScan();
	});

	/* ---------- background 通信 ---------- */

	function bg(type, payload) {
		return new Promise((resolve, reject) => {
			try {
				chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
					const err = chrome.runtime.lastError;
					if (err) return reject(new Error(err.message));
					if (!res || !res.ok) return reject(new Error((res && res.error) || "不明なエラー"));
					resolve(res.data);
				});
			} catch (err) {
				// 拡張機能の再読み込み後、古いタブの content script では runtime が無効になる。
				reject(new Error("拡張機能が更新されました。ページを再読み込みしてください"));
			}
		});
	}

	/* ---------- 設定 ---------- */

	/*
	 * X は <html> の class 属性を自身の描画で上書きするため、class の付与ではなく専用の <style> 要素で
	 * 標準ブックマークボタンを非表示にする。要素が DOM から外された場合は scan() で再挿入する。
	 * 非表示にするのは attach() で保存ボタンを挿入した位置の標準ボタンのみとし、
	 * 保存ボタンを挿入できなかったツイートでは標準ボタンを残す。
	 */
	const HIDE_NATIVE_CSS = "[data-tvault-native-bm] { display: none !important; }";
	let hideNative = true;
	let hideStyle = null;

	function ensureHideStyle() {
		if (!hideStyle) {
			hideStyle = document.createElement("style");
			hideStyle.id = "tvault-hide-native";
		}
		hideStyle.textContent = hideNative ? HIDE_NATIVE_CSS : "";
		const parent = document.head || document.documentElement;
		if (parent && !hideStyle.isConnected) parent.appendChild(hideStyle);
	}

	function applyHideNative(hide) {
		hideNative = hide !== false;
		ensureHideStyle();
	}

	// 設定の取得は非同期のため、取得前は既定値 true で適用し、標準ボタンが一瞬表示される状態を防ぐ。
	ensureHideStyle();
	chrome.storage.local.get({ hideNativeBookmark: true }, (v) => applyHideNative(v.hideNativeBookmark));
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.hideNativeBookmark) applyHideNative(changes.hideNativeBookmark.newValue);
	});

	/* ---------- 保存状態 ---------- */

	// value が null は未保存、{ folderId, tags } は保存済み、キー無しは未取得を表す。
	const status = new Map();
	const saving = new Set();
	const buttons = new Map();
	const pendingIds = new Set();
	// 保存処理中にポップオーバーで選択されたフォルダ・タグ。保存完了後に updateTweet で反映する。
	// ポップオーバーを閉じても保持するため、ポップオーバーの状態とは別に管理する。
	const drafts = new Map();
	// ローカルで保存状態を変更するたびに加算する。getStatus の応答がこれより古い場合は破棄する。
	const generation = new Map();
	// ツイートごとの updateTweet 送信番号。ポップオーバーを開き直しても、最後に送った要求の応答のみを反映する。
	const updateSeq = new Map();
	const STATUS_CHUNK = 400;
	let flushTimer = 0;

	function setStatus(id, value) {
		status.set(id, value);
		generation.set(id, (generation.get(id) || 0) + 1);
		paint(id);
	}

	function requestStatus(id) {
		pendingIds.add(id);
		if (!flushTimer) flushTimer = setTimeout(flushStatus, 80);
	}

	async function flushStatus() {
		flushTimer = 0;
		const ids = [...pendingIds];
		pendingIds.clear();
		pruneButtons();
		if (!ids.length) return;
		// background は 1 要求あたりの ID 数を制限するため、上限以下に分割して問い合わせる。
		for (let i = 0; i < ids.length; i += STATUS_CHUNK) {
			const chunk = ids.slice(i, i + STATUS_CHUNK);
			const before = chunk.map((id) => generation.get(id) || 0);
			try {
				const res = await bg("getStatus", { ids: chunk });
				chunk.forEach((id, j) => {
					if (saving.has(id) || (generation.get(id) || 0) !== before[j]) return;
					status.set(id, res[id] || null);
					paint(id);
				});
			} catch {
				/* 取得失敗時は未保存表示のまま維持する */
			}
		}
	}

	function pruneButtons() {
		for (const [id, set] of buttons) {
			for (const b of set) if (!b.isConnected) set.delete(b);
			if (!set.size) buttons.delete(id);
		}
	}

	function stateOf(id) {
		if (saving.has(id)) return "saving";
		return status.get(id) ? "saved" : "unsaved";
	}

	function setButtonState(btn, st) {
		if (btn.dataset.state === st) return;
		btn.dataset.state = st;
		btn.innerHTML = st === "saved" ? ICON_SAVED : ICON_OUTLINE;
		const label =
			st === "saved" ? "Vault に保存済み (クリックで編集)" : st === "saving" ? "Vault に保存中…" : "Vault に保存";
		btn.title = label;
		btn.setAttribute("aria-label", label);
	}

	function paint(id) {
		const st = stateOf(id);
		for (const b of buttons.get(id) || []) setButtonState(b, st);
	}

	// 他タブや一覧ページで変更された保存状態を、タブ再表示時に再取得する。
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		pruneButtons();
		for (const id of buttons.keys()) requestStatus(id);
	});

	/* ---------- DOM 解析 ---------- */
	/*
	 * X の DOM には 2 種類の構造が存在するため、両方のセレクタを併記する。
	 *   旧: data-testid ("tweet", "reply", "like", "bookmark", "tweetText", "User-Name" など) と <time>
	 *   新: data-engagement-action ("reply", "like", "bookmark", "share") と data-post-avatar。<time> は無い
	 */

	const REPLY_MARK = '[data-engagement-action="reply"], [data-testid="reply"]';
	const LIKE_MARK = '[data-engagement-action="like"], [data-testid="like"], [data-testid="unlike"]';
	const NATIVE_BOOKMARK =
		'[data-engagement-action="bookmark"], [data-testid="bookmark"], [data-testid="removeBookmark"]';
	const SHARE = '[data-engagement-action="share"], [data-testid="share"]';
	const STATUS_PATH_RE = /^\/([^/?#]+)\/status\/(\d+)\/?(?:[?#].*)?$/;

	function inQuote(el, article) {
		const q = el.closest('div[role="link"]');
		return !!q && article.contains(q);
	}

	function isActionBar(g) {
		return !!g.querySelector(REPLY_MARK) && !!g.querySelector(LIKE_MARK);
	}

	/*
	 * アクションバー (返信と いいね の両方を含む group) を持つ article を列挙する。
	 * アクションバーが入れ子になっている場合は最も内側のものを対象とし、
	 * 共有メニューなど一部の操作のみを囲む内側の group は判定に影響させない。
	 */
	function findActionGroups() {
		const out = [];
		for (const g of document.querySelectorAll('[role="group"]')) {
			if (!isActionBar(g)) continue;
			if ([...g.querySelectorAll('[role="group"]')].some(isActionBar)) continue;
			const article = g.closest("article");
			if (!article || inQuote(g, article)) continue;
			out.push([article, g]);
		}
		return out;
	}

	// 投稿者アイコンのリンク先 (/screen_name) から、article の先頭に表示される投稿者の screen_name を得る。
	function authorOf(article) {
		const a = pickOutsideQuote(
			article,
			'[data-post-avatar] a[href^="/"], [data-testid="Tweet-User-Avatar"] a[href^="/"]',
		)[0];
		const m = a && /^\/([^/?#]+)/.exec(a.getAttribute("href") || "");
		return m ? m[1].toLowerCase() : "";
	}

	/*
	 * ツイート ID を次の優先順で特定する。
	 * 1. アクションバー内の返信リンク (?in_reply_to=ID)。findActionGroups は引用カード外の group のみを渡す。
	 * 2. 旧 DOM の <time> を含む permalink (引用ツイート内を除く)。
	 * 3. article 内の permalink (/user/status/ID)。旧 DOM の引用カード内は除外する。
	 *    新 DOM では引用カードを判別できないため、投稿者アイコンの screen_name と一致する permalink のみを候補とし、
	 *    一致する候補が無い場合は ID を特定できないものとして空文字を返す。
	 *    候補が複数ある場合 (自身のツイートの引用) はキャッシュ上で他の候補を引用しているツイートを本体とし、
	 *    判定できない場合は先頭を採用する。キャッシュ更新時とクリック時に再判定する。
	 */
	function getTweetId(article, group) {
		const reply = group.querySelector('a[href*="in_reply_to="]');
		const r = reply && /[?&]in_reply_to=(\d+)/.exec(reply.getAttribute("href") || "");
		if (r) return r[1];

		const found = [];
		let timed = "";
		for (const a of article.querySelectorAll('a[href*="/status/"]')) {
			const href = a.getAttribute("href") || "";
			if (!timed && a.querySelector("time") && !inQuote(a, article)) {
				const m = /\/status\/(\d+)/.exec(href);
				if (m) timed = m[1];
			}
			const m = STATUS_PATH_RE.exec(href);
			if (m && !found.some((f) => f.id === m[2]) && !inQuote(a, article))
				found.push({ user: m[1].toLowerCase(), id: m[2] });
		}
		if (timed) return timed;
		const author = authorOf(article);
		// /i/status/ID 形式の permalink は screen_name を含まないため、投稿者を問わず候補とする。
		const ids = (author ? found.filter((f) => f.user === author || f.user === "i") : found).map((f) => f.id);
		if (ids.length <= 1) return ids[0] || "";
		const quoting = ids.find((id) => {
			const t = cache.get(id);
			return t && t.quote && ids.includes(t.quote.id);
		});
		return quoting || ids[0];
	}

	// 絵文字は img[alt] で描画されるため、alt を本文に含めて連結する。
	function domText(el) {
		let s = "";
		const walk = (n) => {
			if (n.nodeType === Node.TEXT_NODE) {
				s += n.nodeValue;
			} else if (n.nodeType === Node.ELEMENT_NODE) {
				if (n.tagName === "IMG") {
					s += n.getAttribute("alt") || "";
				} else if (n.tagName === "BR") {
					s += "\n";
				} else {
					n.childNodes.forEach(walk);
				}
			}
		};
		el.childNodes.forEach(walk);
		return s.replace(/…$/, "").trim();
	}

	function pickOutsideQuote(article, selector) {
		return [...article.querySelectorAll(selector)].filter((el) => !inQuote(el, article));
	}

	// GraphQL キャッシュと syndication API の両方で取得できない場合のフォールバック。
	// 動画は blob: URL で再生されるため取得できず、サムネイルのみを保存対象とする。
	function fromDom(article, id) {
		const textEl =
			pickOutsideQuote(article, '[data-testid="tweetText"]')[0] ||
			pickOutsideQuote(article, 'div[dir="auto"]').find((el) => !el.closest('[role="group"]'));
		const timeEl = pickOutsideQuote(article, "time")[0];
		const permalink = [...article.querySelectorAll('a[href*="/status/"]')]
			.map((a) => STATUS_PATH_RE.exec(a.getAttribute("href") || ""))
			.find((m) => m && m[2] === id);
		const avatarLink = pickOutsideQuote(article, '[data-post-avatar] a[href^="/"]')[0];
		let screenName = permalink ? permalink[1] : avatarLink ? (avatarLink.getAttribute("href") || "").slice(1) : "";

		let name = "";
		const nameEl = pickOutsideQuote(article, '[data-testid="User-Name"]')[0];
		if (nameEl) {
			const first = nameEl.querySelector("a");
			if (first) name = domText(first);
			if (!screenName) {
				const handle = [...nameEl.querySelectorAll("span")]
					.map((s) => s.textContent || "")
					.find((t) => t.startsWith("@"));
				if (handle) screenName = handle.slice(1);
			}
		} else if (screenName) {
			// 新 DOM ではプロフィールへのリンクのうち、@ で始まらないテキストを表示名とする。
			const link = pickOutsideQuote(article, `a[href="/${CSS.escape(screenName)}"]`).find(
				(a) => !a.closest("[data-post-avatar]") && !(a.textContent || "").trim().startsWith("@"),
			);
			if (link) name = domText(link);
		}

		const avatar = pickOutsideQuote(article, '[data-testid="Tweet-User-Avatar"] img, [data-post-avatar] img')[0];
		const media = [];
		const seenPhotos = new Set();
		for (const img of pickOutsideQuote(
			article,
			'[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]',
		)) {
			if (img.closest('[data-testid="videoPlayer"], [data-post-avatar]')) continue;
			const url = P.photoUrl(img.currentSrc || img.src);
			const key = url.split("?")[0];
			if (seenPhotos.has(key)) continue;
			seenPhotos.add(key);
			media.push({
				type: "photo",
				url,
				posterUrl: "",
				width: img.naturalWidth || 0,
				height: img.naturalHeight || 0,
			});
		}
		for (const v of pickOutsideQuote(article, "video")) {
			const src = v.currentSrc || v.src || "";
			media.push({
				type: "video",
				url: /^https:/.test(src) ? src : "",
				posterUrl: v.getAttribute("poster") || "",
				width: 0,
				height: 0,
			});
		}
		return {
			id,
			url: `https://x.com/${screenName || "i"}/status/${id}`,
			text: textEl ? domText(textEl) : "",
			createdAt: (timeEl && timeEl.getAttribute("datetime")) || P.timeFromId(id),
			lang: (textEl && textEl.getAttribute("lang")) || "",
			author: { name: name || screenName, screenName, avatarUrl: P.avatarUrl(avatar ? avatar.src : "") },
			media,
			quote: null,
			source: "dom",
		};
	}

	async function resolveTweet(id, article) {
		const cached = cache.get(id);
		if (cached) return cached;
		try {
			const s = await bg("fetchSyndication", { id });
			if (s) return s;
		} catch {
			/* DOM 解析へフォールバックする */
		}
		// syndication の待機中に API レスポンスが届いた場合はキャッシュを優先する。
		const late = cache.get(id);
		if (late) return late;
		try {
			await loadParse();
		} catch (err) {
			throw new Error(`ツイート情報を取得できませんでした: ${err.message}`);
		}
		// 待機中に仮想スクロールで article が別ツイートへ再利用された場合、その DOM を id のツイートとして保存しない。
		const group = article && article.isConnected ? findActionGroups().find(([a]) => a === article)?.[1] : null;
		if (group && getTweetId(article, group) === id) return fromDom(article, id);
		throw new Error("ツイート情報を取得できませんでした");
	}

	/* ---------- ボタン挿入 ---------- */

	// 標準ブックマークボタンを単独で包む親要素があればそれを、無ければボタン自身を非表示・挿入位置の基準とする。
	function nativeHolder(group) {
		const native = group.querySelector(NATIVE_BOOKMARK);
		if (!native) return null;
		const parent = native.parentElement;
		return parent && parent !== group && parent.children.length === 1 ? parent : native;
	}

	/*
	 * data-tvault-native-bm は Tweet Vault のボタンが存在する group の標準ブックマークにのみ付与する。
	 * X はボタンの状態変化や再描画で標準ブックマークの要素を差し替えるため、走査のたびに付与先を再計算する。
	 */
	function markNative(group, holder) {
		for (const el of group.querySelectorAll("[data-tvault-native-bm]")) {
			if (el !== holder) el.removeAttribute("data-tvault-native-bm");
		}
		if (holder && !holder.hasAttribute("data-tvault-native-bm")) holder.setAttribute("data-tvault-native-bm", "");
	}

	function detach(group) {
		group.querySelector(".tvault-wrap")?.remove();
		markNative(group, null);
	}

	/*
	 * inject.js が group を React の管理外 (ハイドレーション前) と判定した場合は挿入を延期する。
	 * inject.js が動作していない場合は preventDefault() が呼ばれないため、延期せずに挿入する。
	 * React のファイバー参照の名称が変わり判定が常に延期となる場合に備え、ページの読み込みが完了し、
	 * かつ時間原点から HYDRATION_WAIT_MS 経過した後は判定せずに挿入する。
	 */
	const HYDRATION_WAIT_MS = 15000;
	const HYDRATION_RETRY_MS = 300;
	let hydrationRetry = 0;
	function awaitingHydration(group) {
		if (document.readyState === "complete" && performance.now() > HYDRATION_WAIT_MS) return false;
		if (group.dispatchEvent(new CustomEvent("tvault:hydration-check", { cancelable: true }))) return false;
		// ハイドレーションは DOM を変更しないため、MutationObserver に頼らず再走査を予約する。
		if (!hydrationRetry) {
			hydrationRetry = setTimeout(() => {
				hydrationRetry = 0;
				queueScan();
			}, HYDRATION_RETRY_MS);
		}
		return true;
	}

	function attach(article, group) {
		const id = getTweetId(article, group);
		const existing = group.querySelector(`.${BTN_CLASS}`);
		if (!id) {
			// 仮想スクロールで ID を特定できないツイートに再利用された article から、以前のツイートのボタンを外す。
			detach(group);
			return;
		}
		if (existing) {
			if (existing.dataset.id === id) {
				markNative(group, nativeHolder(group));
				return;
			}
			// 仮想スクロールで article 要素が別ツイートに再利用された場合は作り直す。
			// 再挿入がハイドレーション待ちで延期されても標準ブックマークが表示されるよう、非表示の指定も外す。
			detach(group);
		}
		if (awaitingHydration(group)) return;

		const wrap = document.createElement("div");
		wrap.className = "tvault-wrap";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = BTN_CLASS;
		btn.dataset.id = id;
		wrap.appendChild(btn);

		// 標準ブックマークボタンの直前に挿入し、同じ位置に表示する。
		// 挿入に失敗した場合に標準ボタンが非表示のまま残らないよう、非表示の指定は挿入後に行う。
		const holder = nativeHolder(group);
		if (holder) {
			holder.parentElement.insertBefore(wrap, holder);
			markNative(group, holder);
		} else {
			let shareHolder = group.querySelector(SHARE);
			while (shareHolder && shareHolder.parentElement !== group) shareHolder = shareHolder.parentElement;
			if (shareHolder) group.insertBefore(wrap, shareHolder);
			else group.appendChild(wrap);
		}

		btn.addEventListener("click", onButtonClick);
		btn.addEventListener("pointerdown", onButtonPointerDown);
		btn.addEventListener("contextmenu", onButtonContextMenu);
		btn.addEventListener("touchmove", onButtonTouchMove, { passive: false });
		if (!buttons.has(id)) buttons.set(id, new Set());
		buttons.get(id).add(btn);
		setButtonState(btn, stateOf(id));
		if (!status.has(id)) requestStatus(id);
	}

	function rebind(btn, oldId, newId) {
		buttons.get(oldId)?.delete(btn);
		btn.dataset.id = newId;
		if (!buttons.has(newId)) buttons.set(newId, new Set());
		buttons.get(newId).add(btn);
		setButtonState(btn, stateOf(newId));
		if (!status.has(newId)) requestStatus(newId);
	}

	function scan() {
		if (hideStyle && !hideStyle.isConnected) ensureHideStyle();
		for (const [article, group] of findActionGroups()) {
			try {
				attach(article, group);
			} catch {
				/* 個別ツイートの失敗で全体の処理を止めない */
			}
		}
	}

	// X の DOM は描画のたびに変化するため、変更が続く間の走査を 150ms 間隔にまとめる。
	let scanTimer = 0;
	function queueScan() {
		if (scanTimer) return;
		scanTimer = setTimeout(() => {
			scanTimer = 0;
			scan();
		}, 150);
	}

	new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });

	/* ---------- 保存処理 ---------- */

	// 挿入時にキャッシュが無く引用先の ID を採用していた場合に備え、操作時点のキャッシュで ID を再判定する。
	function currentId(btn) {
		let id = btn.dataset.id;
		const article = btn.closest("article");
		const group = btn.closest('[role="group"]');
		if (article && group && !saving.has(id) && !popover.isOpenFor(btn)) {
			const fresh = getTweetId(article, group);
			if (fresh && fresh !== id) {
				rebind(btn, id, fresh);
				id = fresh;
			}
		}
		return id;
	}

	async function onButtonClick(e) {
		// article のクリックでツイート詳細へ遷移するため、ページ側へのイベント伝播を止める。
		e.preventDefault();
		e.stopPropagation();
		const btn = e.currentTarget;
		// 長押しでメニューを開いた直後に届くクリックは、単押しとして扱わない。
		if ((suppressClick.get(btn) || 0) > performance.now()) return;
		const id = currentId(btn);
		if (goo.isOpenFor(btn)) {
			goo.close(e.detail === 0);
			return;
		}
		// 保存処理中のクリックでポップオーバーを閉じると完了・失敗の表示先が無くなるため、開くのみとする。
		if (saving.has(id)) {
			goo.dismiss(btn);
			if (!popover.isOpenFor(btn)) popover.open(btn, id);
			return;
		}
		if (popover.isOpenFor(btn)) {
			const failed = popover.isFailed();
			popover.close();
			// 保存失敗の表示中にボタンを押した場合は保存を再試行する。
			if (failed && !saving.has(id) && !status.get(id)) await quickSave(btn, id);
			return;
		}
		if (status.get(id)) {
			popover.open(btn, id);
			return;
		}
		await quickSave(btn, id);
	}

	/* ---------- 長押し・右クリックで Goo メニュー (保存先フォルダの選択) ---------- */

	const goo = globalThis.TVaultGoo;
	const LONG_PRESS_MS = 400;
	const HOLD_SLOP = 8; // 長押しの判定中にこれ以上動いたらスクロールなどとみなして取り消す (px)
	const suppressClick = new WeakMap();
	let hold = null;

	function onButtonPointerDown(e) {
		if (e.button !== 0 || !e.isPrimary) return;
		const btn = e.currentTarget;
		cancelHold();
		const h = { btn, pointerId: e.pointerId, touch: e.pointerType === "touch", x: e.clientX, y: e.clientY };
		h.fired = false;
		h.timer = setTimeout(() => fireHold(h), LONG_PRESS_MS);
		hold = h;
		window.addEventListener("pointermove", onHoldMove, true);
		window.addEventListener("pointerup", onHoldEnd, true);
		window.addEventListener("pointercancel", onHoldEnd, true);
	}

	// 長押しが成立したとき、または押したまま右へ動かしたときに泡を出す。
	function fireHold(h) {
		if (hold !== h || h.fired || !h.btn.isConnected) return;
		clearTimeout(h.timer);
		h.fired = true;
		if (h.touch) navigator.vibrate?.(10);
		openFolderMenu(h.btn, currentId(h.btn), false);
	}

	// 押したまま右へ動かしたか (右向きの移動が上下の移動より大きい)。
	function draggedRight(h, x, y) {
		const dx = x - h.x;
		return dx > HOLD_SLOP && dx > Math.abs(y - h.y);
	}

	function onHoldMove(e) {
		if (!hold || e.pointerId !== hold.pointerId) return;
		if (!hold.fired) {
			// 右へ動かした瞬間に、長押しを待たずに泡を出す。それ以外の向きはスクロールなどとみなして取り消す。
			if (draggedRight(hold, e.clientX, e.clientY)) fireHold(hold);
			else if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) cancelHold();
		}
		if (hold?.fired) goo.hoverAt(hold.btn, e.clientX, e.clientY);
	}

	// 長押しで開いた後、押したまま泡の上へ動かして離すと、そのフォルダを選べる。
	function onHoldEnd(e) {
		if (!hold || e.pointerId !== hold.pointerId) return;
		const h = hold;
		cancelHold();
		if (!h.fired) return;
		suppressClick.set(h.btn, performance.now() + 500);
		if (e.type === "pointerup") goo.releaseAt(h.btn, e.clientX, e.clientY);
	}

	function cancelHold() {
		if (!hold) return;
		clearTimeout(hold.timer);
		hold = null;
		window.removeEventListener("pointermove", onHoldMove, true);
		window.removeEventListener("pointerup", onHoldEnd, true);
		window.removeEventListener("pointercancel", onHoldEnd, true);
	}

	/*
	 * タッチでは指を動かすとページのスクロールが始まり、pointercancel で長押しの操作が打ち切られる。
	 * 長押しが成立した後、または右へ動かした場合に限りスクロールを止め、指を泡の上まで滑らせられるようにする。
	 * それ以外は止めないため、保存ボタンの上から始めた縦のスクロールはそのまま動く。
	 */
	function onButtonTouchMove(e) {
		const h = hold;
		if (!h || h.btn !== e.currentTarget) return;
		const t = e.touches[0];
		if (!h.fired && t && draggedRight(h, t.clientX, t.clientY)) fireHold(h);
		if (h.fired) e.preventDefault();
	}

	// 右クリックやメニューキーでも開く。タッチの長押しで届く contextmenu は長押しの処理に任せる。
	function onButtonContextMenu(e) {
		e.preventDefault();
		e.stopPropagation();
		const btn = e.currentTarget;
		if (hold?.fired || goo.isOpenFor(btn)) return;
		cancelHold();
		openFolderMenu(btn, currentId(btn), true);
	}

	let foldersLoading = null;

	// 取得できない場合は未分類のみとし、保存時のエラーで理由を示す。同じボタンで取得中なら null を返す。
	async function loadFolders(btn) {
		if (foldersLoading === btn) return null;
		foldersLoading = btn;
		let folders = [];
		let lastFolderId = "default";
		try {
			[folders, { lastFolderId }] = await Promise.all([
				bg("listFolders"),
				chrome.storage.local.get({ lastFolderId: "default" }),
			]);
		} catch {
			/* 下で未分類を補う */
		} finally {
			if (foldersLoading === btn) foldersLoading = null;
		}
		if (!folders.length) folders = [{ id: "default", name: "未分類" }];
		return { folders, lastFolderId };
	}

	// 取得を待つ間にボタンが外れた・別ツイートに再利用された・保存が始まった場合は続けない。
	function stillValid(btn, id) {
		return btn.isConnected && btn.dataset.id === id && !saving.has(id);
	}

	// トーストを押すと、続けてタグなどを編集できるようポップオーバーを開く。
	function toastClick(btn, id) {
		return () => {
			if (btn.isConnected) popover.open(btn, id);
		};
	}

	// 単押し: 前回使ったフォルダへすぐ保存し、ボタンをトーストに変形させる。
	async function quickSave(btn, id) {
		const data = await loadFolders(btn);
		if (!data || !stillValid(btn, id) || status.get(id)) return;
		const folder = data.folders.find((f) => f.id === data.lastFolderId) || data.folders[0];
		popover.close();
		goo.toast(btn, { onToastClick: toastClick(btn, id) });
		save(id, btn.closest("article"), btn, folder, data.folders);
	}

	// 長押し: 登録フォルダを泡として横に広げる。未保存なら選んだフォルダへ保存し、保存済みならそのフォルダへ移動する。
	async function openFolderMenu(btn, id, byKeyboard) {
		if (saving.has(id)) return;
		const data = await loadFolders(btn);
		if (!data || !stillValid(btn, id) || goo.isOpenFor(btn)) return;
		const { folders, lastFolderId } = data;
		const saved = status.get(id);
		popover.close();
		goo.open(btn, {
			folders,
			currentId: saved ? saved.folderId : lastFolderId,
			verb: saved ? "へ移動" : "に保存",
			focus: byKeyboard,
			onPick(folder) {
				chrome.storage.local.set({ lastFolderId: folder.id }).catch(() => {});
				if (status.get(id)) moveTo(id, btn, folder);
				else if (!saving.has(id)) save(id, btn.closest("article"), btn, folder, folders);
			},
			onToastClick: toastClick(btn, id),
		});
	}

	async function moveTo(id, btn, folder) {
		const prev = status.get(id);
		if (prev.folderId === folder.id) {
			goo.setToast(btn, { state: "done", name: folder.name, text: "に保存済みです" });
			return;
		}
		goo.setToast(btn, { state: "busy", name: folder.name, text: "へ移動中…" });
		// ポップオーバーでの編集と同じく、最後に送った要求の応答のみを反映する。
		const seq = (updateSeq.get(id) || 0) + 1;
		updateSeq.set(id, seq);
		setStatus(id, { folderId: folder.id, tags: [...prev.tags] });
		try {
			const res = await bg("updateTweet", { id, folderId: folder.id });
			if (updateSeq.get(id) !== seq) return;
			setStatus(id, { folderId: res.folderId, tags: res.tags });
			goo.setToast(btn, { state: "done", name: folder.name, text: "へ移動しました" });
		} catch {
			if (updateSeq.get(id) !== seq) return;
			setStatus(id, prev);
			requestStatus(id);
			goo.setToast(btn, { state: "error", name: folder.name, text: "へ移動できませんでした" });
		}
	}

	function savedToast(saved, folders) {
		const name = folders.find((f) => f.id === saved.folderId)?.name;
		if (saved.existed) return { state: "done", name, text: name ? "に保存済みです" : "既に保存済みです" };
		if (saved.mediaFailed)
			return { state: "done", name, text: `に保存 (メディア ${saved.mediaFailed} 件は未取得)` };
		return { state: "done", name, text: name ? "に保存しました" : "保存しました" };
	}

	async function save(id, article, btn, folder, folders) {
		saving.add(id);
		paint(id);
		let saved = null;
		let failure = null;
		try {
			drafts.set(id, {
				folderId: folder.id,
				tags: [],
				dirty: false,
				folderChanged: false,
				tagsChanged: false,
			});
			goo.setToast(btn, { state: "busy", name: folder.name, text: "に保存中…" });
			const tweet = await resolveTweet(id, article);
			saved = await bg("saveTweet", { tweet, folderId: folder.id, tags: [] });
			// 既に保存済みだった場合、draft は既存のフォルダ・タグを知らない状態で編集されているため破棄し、
			// ポップオーバーには DB の値を表示する。
			// 新規保存の場合は draft に蓄積された変更を、dirty が解消されるまで変更項目のみ繰り返し反映する。
			for (let d = drafts.get(id); !saved.existed && d && d.dirty; d = drafts.get(id)) {
				d.dirty = false;
				const patch = { id };
				if (d.folderChanged) patch.folderId = d.folderId;
				if (d.tagsChanged) patch.tags = d.tags;
				d.folderChanged = false;
				d.tagsChanged = false;
				saved = { ...saved, ...(await bg("updateTweet", patch)) };
			}
		} catch (err) {
			failure = err;
		} finally {
			drafts.delete(id);
			saving.delete(id);
		}
		if (saved) {
			setStatus(id, { folderId: saved.folderId, tags: saved.tags });
			// saveTweet 成功後の updateTweet で失敗した場合は、トーストではなくポップオーバーで未反映である旨を表示する。
			if (failure && !popover.isOpenFor(btn)) {
				goo.dismiss(btn);
				if (btn.isConnected) popover.open(btn, id);
			}
			if (!failure) goo.setToast(btn, savedToast(saved, folders));
			popover.onSaved(id, saved, failure);
		} else {
			paint(id);
			// 失敗はトーストを閉じ、ポップオーバーで理由と再試行の方法を示す。
			goo.dismiss(btn);
			if (btn.isConnected && !popover.isOpenFor(btn)) popover.open(btn, id);
			popover.onError(id, failure || new Error("保存できませんでした"));
		}
	}

	/* ---------- ポップオーバー ---------- */

	const POP_CSS = `
    :host { all: initial; }
    .pop {
      position: fixed; z-index: 2147483646; width: 300px; box-sizing: border-box;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: var(--shadow); padding: 14px; display: flex; flex-direction: column; gap: 10px;
    }
    .pop[hidden] { display: none; }
    .pop[data-theme="light"] { --bg:#fff; --fg:#0f1419; --sub:#536471; --line:#cfd9de; --hover:#f7f9f9; --chip:#e8f5fd; --shadow: 0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15); }
    .pop[data-theme="dark"]  { --bg:#000; --fg:#e7e9ea; --sub:#71767b; --line:#2f3336; --hover:#16181c; --chip:#0b2a3f; --shadow: 0 0 15px rgba(255,255,255,.2), 0 0 3px 1px rgba(255,255,255,.15); }
    .head { display: flex; align-items: center; gap: 8px; }
    .title { font-weight: 700; font-size: 15px; flex: 1; }
    .status { font-size: 12px; color: var(--sub); }
    .status.err { color: #f4212e; }
    .x { all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: var(--sub); }
    .x:hover { background: var(--hover); }
    .label { font-size: 12px; font-weight: 700; color: var(--sub); }
    .folders { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow-y: auto; margin: 0 -4px; }
    .folder { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; }
    .folder:hover { background: var(--hover); }
    .folder .dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); box-sizing: border-box; flex: none; }
    .folder[aria-checked="true"] .dot { border: 4px solid #1d9bf0; }
    .folder .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row { display: flex; gap: 6px; }
    input {
      all: unset; box-sizing: border-box; flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--line);
      border-radius: 8px; font-size: 13px; color: var(--fg);
    }
    input:focus { border-color: #1d9bf0; box-shadow: 0 0 0 1px #1d9bf0; }
    input::placeholder { color: var(--sub); }
    .btn { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 9999px; font-size: 13px; font-weight: 700; text-align: center; }
    .btn.primary { background: var(--fg); color: var(--bg); }
    .btn.ghost { border: 1px solid var(--line); }
    .btn.ghost:hover { background: var(--hover); }
    .btn.danger { color: #f4212e; border: 1px solid rgba(244,33,46,.4); }
    .btn.danger:hover { background: rgba(244,33,46,.1); }
    .btn[disabled], .folder[disabled], .sug[disabled], .chip button[disabled], input:disabled { opacity: .5; pointer-events: none; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips:empty { display: none; }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border-radius: 9999px; background: var(--chip); color: #1d9bf0; font-size: 13px; }
    .chip button { all: unset; cursor: pointer; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 14px; }
    .chip button:hover { background: rgba(29,155,240,.2); }
    .suggest { display: flex; flex-wrap: wrap; gap: 6px; }
    .suggest:empty { display: none; }
    .sug { all: unset; cursor: pointer; font-size: 12px; color: var(--sub); padding: 2px 8px; border: 1px dashed var(--line); border-radius: 9999px; }
    .sug:hover { color: #1d9bf0; border-color: #1d9bf0; }
    .foot { display: flex; gap: 8px; justify-content: space-between; padding-top: 4px; border-top: 1px solid var(--line); margin-top: 2px; padding-top: 10px; }
  `;

	const popover = (() => {
		let host = null;
		let shadow = null;
		let root = null;
		let cur = null;

		function el(sel) {
			return root.querySelector(sel);
		}

		function ensure() {
			if (host && host.isConnected) return;
			host = document.createElement("div");
			host.id = "tvault-popover-host";
			shadow = host.attachShadow({ mode: "open" });
			shadow.innerHTML = `<style>${POP_CSS}</style>
        <div class="pop" hidden role="dialog" aria-label="Tweet Vault">
          <div class="head"><span class="title"></span><button class="x" data-act="close" aria-label="閉じる">✕</button></div>
          <div class="status"></div>
          <div class="label">フォルダ</div>
          <div class="folders" role="radiogroup"></div>
          <div class="row"><input class="new-folder" placeholder="新しいフォルダ名" maxlength="60"><button class="btn ghost" data-act="create-folder">作成</button></div>
          <div class="label">タグ</div>
          <div class="chips"></div>
          <input class="tag-input" placeholder="タグを入力して Enter" maxlength="50">
          <div class="suggest"></div>
          <div class="foot"><button class="btn danger" data-act="delete">削除</button><button class="btn ghost" data-act="viewer">一覧を開く</button></div>
        </div>`;
			root = shadow.querySelector(".pop");

			// シャドウ DOM 内の入力イベントがページのキーボードショートカットとして処理されないよう伝播を止める。
			for (const type of ["keydown", "keyup", "keypress"]) {
				host.addEventListener(type, (e) => {
					e.stopPropagation();
					if (type === "keydown" && e.key === "Escape") close();
				});
			}
			root.addEventListener("click", onClick);
			el(".tag-input").addEventListener("keydown", (e) => {
				if (e.isComposing) return;
				if (e.key === "Enter" || e.key === ",") {
					e.preventDefault();
					addTags(e.target.value);
					e.target.value = "";
				} else if (e.key === "Backspace" && !e.target.value && cur && cur.tags.length) {
					change({ tags: cur.tags.slice(0, -1) });
				}
			});
			el(".new-folder").addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					createFolder();
				}
			});
			(document.body || document.documentElement).appendChild(host);
		}

		// 新 DOM は <html data-theme> でテーマを示す。属性が無い場合は body の背景色の輝度で判定し、
		// 背景が透明な場合は OS の配色設定に従う。
		function detectTheme() {
			const attr = document.documentElement.getAttribute("data-theme");
			if (attr) return /dark|dim|black/i.test(attr) ? "dark" : "light";
			const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(
				getComputedStyle(document.body).backgroundColor || "",
			);
			if (m && (m[4] === undefined || Number(m[4]) > 0)) {
				const lum = (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255;
				return lum < 0.5 ? "dark" : "light";
			}
			return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		}

		function isOpenFor(btn) {
			return !!cur && cur.btn === btn;
		}

		function isFailed() {
			return !!cur && cur.phase === "error";
		}

		function open(btn, id) {
			ensure();
			const src = (saving.has(id) && drafts.get(id)) || status.get(id) || {};
			cur = {
				btn,
				id,
				phase: saving.has(id) ? "saving" : "saved",
				folderId: src.folderId || "default",
				tags: src.tags ? [...src.tags] : [],
				message: "",
				error: "",
				folders: [],
				allTags: [],
			};
			root.dataset.theme = detectTheme();
			root.hidden = false;
			el(".tag-input").value = "";
			el(".new-folder").value = "";
			render();
			reposition();
			const opened = cur;
			Promise.all([bg("listFolders"), bg("listTags")]).then(
				([folders, tags]) => {
					if (cur !== opened) return;
					cur.folders = folders;
					cur.allTags = tags;
					if (!folders.some((f) => f.id === cur.folderId)) cur.folderId = "default";
					render();
					reposition();
				},
				(err) => {
					if (cur === opened) {
						cur.error = err.message;
						render();
					}
				},
			);
		}

		function close() {
			cur = null;
			if (root) root.hidden = true;
		}

		function render() {
			if (!cur) return;
			const title =
				cur.phase === "saving"
					? "保存中…"
					: cur.phase === "error"
						? "保存できませんでした"
						: "Vault に保存済み";
			el(".title").textContent = title;
			const statusEl = el(".status");
			statusEl.textContent = cur.error || cur.message;
			statusEl.className = cur.error ? "status err" : "status";
			statusEl.hidden = !statusEl.textContent;

			const folders = el(".folders");
			folders.textContent = "";
			const list = cur.folders.length ? cur.folders : [{ id: "default", name: "未分類" }];
			for (const f of list) {
				const b = document.createElement("button");
				b.className = "folder";
				b.setAttribute("role", "radio");
				b.setAttribute("aria-checked", String(f.id === cur.folderId));
				b.dataset.act = "folder";
				b.dataset.id = f.id;
				const dot = document.createElement("span");
				dot.className = "dot";
				const name = document.createElement("span");
				name.className = "name";
				name.textContent = f.name;
				b.append(dot, name);
				folders.appendChild(b);
			}

			const chips = el(".chips");
			chips.textContent = "";
			for (const tag of cur.tags) {
				const c = document.createElement("span");
				c.className = "chip";
				c.append(`#${tag}`);
				const x = document.createElement("button");
				x.dataset.act = "remove-tag";
				x.dataset.tag = tag;
				x.setAttribute("aria-label", `${tag} を外す`);
				x.textContent = "×";
				c.appendChild(x);
				chips.appendChild(c);
			}

			const sug = el(".suggest");
			sug.textContent = "";
			const lower = new Set(cur.tags.map((t) => t.toLowerCase()));
			for (const { tag } of cur.allTags.filter((t) => !lower.has(t.tag.toLowerCase())).slice(0, 12)) {
				const b = document.createElement("button");
				b.className = "sug";
				b.dataset.act = "add-tag";
				b.dataset.tag = tag;
				b.textContent = `#${tag}`;
				sug.appendChild(b);
			}

			el('[data-act="delete"]').disabled = cur.phase !== "saved" || !!cur.deleting;
			// 保存失敗時は DB にレコードが無く、削除中は削除後に更新が届くため、編集操作を無効化する。
			const locked = cur.phase === "error" || cur.deleting;
			for (const ctl of root.querySelectorAll(
				'.folder, .sug, .chip button, .tag-input, .new-folder, [data-act="create-folder"]',
			)) {
				ctl.disabled = locked;
			}
		}

		function reposition() {
			if (!cur || !root) return;
			if (!cur.btn.isConnected) {
				close();
				return;
			}
			const r = cur.btn.getBoundingClientRect();
			const w = root.offsetWidth || 300;
			const h = root.offsetHeight || 360;
			let top = r.bottom + 6;
			if (top + h > innerHeight - 8 && r.top - h - 6 >= 8) top = r.top - h - 6;
			top = Math.max(8, Math.min(top, innerHeight - h - 8));
			const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
			root.style.top = `${top}px`;
			root.style.left = `${left}px`;
		}

		async function change(patch) {
			if (!cur || cur.deleting) return;
			Object.assign(cur, patch);
			cur.error = "";
			render();
			if (patch.folderId) chrome.storage.local.set({ lastFolderId: patch.folderId });
			const draft = saving.has(cur.id) && drafts.get(cur.id);
			if (draft) {
				Object.assign(draft, { folderId: cur.folderId, tags: [...cur.tags], dirty: true });
				if (patch.folderId !== undefined) draft.folderChanged = true;
				if (patch.tags !== undefined) draft.tagsChanged = true;
				return;
			}
			if (cur.phase === "saved") await persist(cur);
		}

		async function persist(c) {
			const id = c.id;
			// 連続した編集の応答は順不同で届くため、最後に送った要求の応答のみ表示へ反映する。
			const seq = (updateSeq.get(id) || 0) + 1;
			updateSeq.set(id, seq);
			// 応答前にポップオーバーを開き直した場合も最新の編集内容から始まるよう、送信時点で status を更新する。
			const prev = status.get(id);
			setStatus(id, { folderId: c.folderId, tags: [...c.tags] });
			try {
				const res = await bg("updateTweet", { id, folderId: c.folderId, tags: c.tags });
				if (updateSeq.get(id) !== seq) return;
				setStatus(id, { folderId: res.folderId, tags: res.tags });
				if (cur === c) {
					c.folderId = res.folderId;
					c.tags = [...res.tags];
					c.message = "変更を保存しました";
					render();
				}
			} catch (err) {
				if (updateSeq.get(id) !== seq) return;
				// 送信時点で更新した status を送信前の値へ戻し、DB の内容でも再確認する。
				setStatus(id, prev);
				requestStatus(id);
				if (cur === c) {
					if (prev) {
						c.folderId = prev.folderId;
						c.tags = [...prev.tags];
					} else {
						c.phase = "error";
					}
					c.error = err.message;
					render();
				}
			}
		}

		function addTags(text) {
			if (!cur) return;
			const add = String(text || "")
				.split(/[,、\n]/)
				.map((s) => s.replace(/^[#＃]+/, "").trim())
				.filter(Boolean);
			if (!add.length) return;
			const lower = new Set(cur.tags.map((t) => t.toLowerCase()));
			const next = [...cur.tags];
			for (const t of add) {
				if (!lower.has(t.toLowerCase())) {
					lower.add(t.toLowerCase());
					next.push(t);
				}
			}
			change({ tags: next });
		}

		async function createFolder() {
			if (!cur) return;
			const input = el(".new-folder");
			const name = input.value.trim();
			if (!name) return;
			const c = cur;
			try {
				const f = await bg("createFolder", { name });
				input.value = "";
				if (cur !== c) return;
				if (!c.folders.some((x) => x.id === f.id)) c.folders.push(f);
				await change({ folderId: f.id });
			} catch (err) {
				if (cur === c) {
					c.error = err.message;
					render();
				}
			}
		}

		async function onClick(e) {
			const target = e.target.closest("[data-act]");
			if (!target || !cur) return;
			const act = target.dataset.act;
			if (act === "close") close();
			else if (act === "folder") change({ folderId: target.dataset.id });
			else if (act === "remove-tag") change({ tags: cur.tags.filter((t) => t !== target.dataset.tag) });
			else if (act === "add-tag") addTags(target.dataset.tag);
			else if (act === "create-folder") createFolder();
			else if (act === "viewer") bg("openViewer").catch(() => {});
			else if (act === "delete") {
				const c = cur;
				try {
					// 削除前に送信済みの updateTweet の応答で保存済み表示へ戻らないよう、送信番号を進める。
					updateSeq.set(c.id, (updateSeq.get(c.id) || 0) + 1);
					c.deleting = true;
					render();
					await bg("deleteTweet", { id: c.id });
					setStatus(c.id, null);
					if (cur === c) close();
				} catch (err) {
					c.deleting = false;
					if (cur === c) {
						c.error = err.message;
						render();
					}
				}
			}
		}

		function onSaved(id, res, draftError) {
			if (!cur || cur.id !== id) return;
			cur.phase = "saved";
			cur.folderId = res.folderId;
			cur.tags = [...res.tags];
			const failed = res.mediaFailed ? ` (${res.mediaFailed} 件のメディアを取得できませんでした)` : "";
			if (res.existed) cur.message = "既に保存済みのツイートです";
			else
				cur.message = res.mediaCount
					? `メディア ${res.mediaCount - res.mediaFailed} 件を保存しました${failed}`
					: "保存しました";
			if (draftError)
				cur.error = `保存しましたが、フォルダ・タグの変更を反映できませんでした: ${draftError.message || draftError}`;
			render();
		}

		function onError(id, err) {
			if (!cur || cur.id !== id) return;
			cur.phase = "error";
			cur.error = `${err.message || err} (保存ボタンをもう一度押すと再試行します)`;
			render();
		}

		// ポップオーバー外のクリックで閉じる。保存ボタン自体のクリックはトグル動作のため除外する。
		document.addEventListener(
			"pointerdown",
			(e) => {
				if (!cur) return;
				const path = e.composedPath();
				if (path.includes(host) || path.includes(cur.btn)) return;
				close();
			},
			true,
		);
		window.addEventListener(
			"scroll",
			() => {
				if (cur) requestAnimationFrame(reposition);
			},
			{ passive: true, capture: true },
		);
		window.addEventListener("resize", () => {
			if (cur) reposition();
		});

		return { open, close, isOpenFor, isFailed, onSaved, onError };
	})();
})();
