/*
 * 拡張機能オリジン (chrome-extension://<id>) の IndexedDB へのアクセス層。
 * background と viewer の両方から import され、同一のデータベースを共有する。
 *
 * ストア構成:
 *   tweets  : keyPath id。正規化ツイート + folderId / tags / savedAt / updatedAt。
 *             media 配列にはメタデータのみを持ち、実体は media ストアに置く。
 *   media   : keyPath key (`${tweetId}:${owner}:${index}`)。blob / posterBlob を保持する。
 *   avatars : keyPath url。アイコン画像の blob を保持し、複数ツイートで共有する。
 *   folders : keyPath id。DEFAULT_FOLDER_ID は常に存在し、削除できない。
 */

const DB_NAME = "tweet-vault";
const DB_VERSION = 1;
export const DEFAULT_FOLDER_ID = "default";
const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 50;
const MAX_FOLDER_NAME = 60;

let dbPromise = null;

export function openDb() {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			const tweets = db.createObjectStore("tweets", { keyPath: "id" });
			tweets.createIndex("savedAt", "savedAt");
			tweets.createIndex("folderId", "folderId");
			tweets.createIndex("tags", "tags", { multiEntry: true });
			const media = db.createObjectStore("media", { keyPath: "key" });
			media.createIndex("tweetId", "tweetId");
			db.createObjectStore("avatars", { keyPath: "url" });
			const folders = db.createObjectStore("folders", { keyPath: "id" });
			folders.put({ id: DEFAULT_FOLDER_ID, name: "未分類", createdAt: 0 });
		};
		req.onsuccess = () => {
			const db = req.result;
			// 他コンテキストがスキーマ更新を要求した場合は接続を閉じ、次回呼び出しで再接続する。
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			resolve(db);
		};
		req.onerror = () => {
			dbPromise = null;
			reject(req.error);
		};
	});
	return dbPromise;
}

function req(r) {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

/*
 * fn 内では IndexedDB リクエストの await のみを行う。
 * IndexedDB 以外の Promise を await するとトランザクションが自動コミットされ、
 * 以降のリクエストが TransactionInactiveError になる。
 */
async function tx(stores, mode, fn) {
	const db = await openDb();
	const t = db.transaction(stores, mode);
	const done = new Promise((resolve, reject) => {
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error || new Error("transaction aborted"));
	});
	let result;
	try {
		result = await fn(t);
	} catch (err) {
		try {
			t.abort();
		} catch {
			/* 既に終了済みのトランザクション */
		}
		done.catch(() => {});
		throw err;
	}
	await done;
	return result;
}

export function normalizeTags(tags) {
	const out = [];
	const seen = new Set();
	for (const raw of Array.isArray(tags) ? tags : []) {
		const tag = String(raw ?? "")
			.replace(/^[#＃]+/, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, MAX_TAG_LENGTH);
		if (!tag) continue;
		const k = tag.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

async function folderExists(t, id) {
	if (!id) return false;
	return !!(await req(t.objectStore("folders").getKey(id)));
}

/* ---------- tweets ---------- */

export function getTweet(id) {
	return tx("tweets", "readonly", (t) => req(t.objectStore("tweets").get(id)));
}

export function listTweets() {
	return tx("tweets", "readonly", (t) => req(t.objectStore("tweets").getAll()));
}

export function getStatuses(ids) {
	return tx("tweets", "readonly", async (t) => {
		const store = t.objectStore("tweets");
		const rows = await Promise.all(ids.map((id) => req(store.get(String(id)))));
		const out = {};
		rows.forEach((r, i) => {
			if (r) out[ids[i]] = { folderId: r.folderId, tags: r.tags };
		});
		return out;
	});
}

// record.folderId が存在しないフォルダを指す場合は DEFAULT_FOLDER_ID へ置き換えて保存する。
export function putTweetBundle(record, mediaRecords, avatarRecords) {
	return tx(["tweets", "media", "avatars", "folders"], "readwrite", async (t) => {
		if (!(await folderExists(t, record.folderId))) record.folderId = DEFAULT_FOLDER_ID;
		record.tags = normalizeTags(record.tags);
		t.objectStore("tweets").put(record);
		for (const m of mediaRecords) t.objectStore("media").put(m);
		for (const a of avatarRecords) t.objectStore("avatars").put(a);
		return record;
	});
}

export function updateTweet(id, patch) {
	return tx(["tweets", "folders"], "readwrite", async (t) => {
		const store = t.objectStore("tweets");
		const r = await req(store.get(id));
		if (!r) throw new Error("ツイートが見つかりません");
		if (patch.folderId !== undefined) {
			r.folderId = (await folderExists(t, patch.folderId)) ? patch.folderId : DEFAULT_FOLDER_ID;
		}
		if (patch.tags !== undefined) r.tags = normalizeTags(patch.tags);
		r.updatedAt = Date.now();
		store.put(r);
		return r;
	});
}

// アバターは複数ツイートで共有されるため、ツイート削除時には削除しない。
export function deleteTweet(id) {
	return tx(["tweets", "media"], "readwrite", async (t) => {
		t.objectStore("tweets").delete(id);
		const media = t.objectStore("media");
		const keys = await req(media.index("tweetId").getAllKeys(id));
		for (const k of keys) media.delete(k);
	});
}

/* ---------- media / avatars ---------- */

export function getMedia(tweetId) {
	return tx("media", "readonly", (t) => req(t.objectStore("media").index("tweetId").getAll(tweetId)));
}

/*
 * 再取得したメディアを既存レコードへ反映する。patch 内で null の blob / posterBlob は既存値を維持する。
 * tweets 側のメタデータの stored / posterStored も同じトランザクションで更新する。
 */
export function patchMedia(tweetId, patches) {
	return tx(["tweets", "media"], "readwrite", async (t) => {
		const tweets = t.objectStore("tweets");
		const media = t.objectStore("media");
		const r = await req(tweets.get(tweetId));
		if (!r) throw new Error("ツイートが見つかりません");
		const metas = [...(r.media || []), ...((r.quote && r.quote.media) || [])];
		for (const p of patches) {
			// 他ツイートのメディアを上書きしないよう、key の接頭辞が tweetId と一致するものだけを反映する。
			if (typeof p.key !== "string" || !p.key.startsWith(`${tweetId}:`)) continue;
			const row = (await req(media.get(p.key))) || {
				key: p.key,
				tweetId,
				owner: p.owner,
				index: p.index,
				type: p.type,
				url: p.url,
				posterUrl: p.posterUrl,
				blob: null,
				posterBlob: null,
			};
			if (p.blob) row.blob = p.blob;
			if (p.posterBlob) row.posterBlob = p.posterBlob;
			media.put(row);
			const meta = metas.find((m) => m.key === p.key);
			if (meta) {
				if (p.blob) meta.stored = true;
				if (p.posterBlob) meta.posterStored = true;
			}
		}
		r.updatedAt = Date.now();
		tweets.put(r);
		return r;
	});
}

export function getAvatar(url) {
	if (!url) return Promise.resolve(null);
	return tx("avatars", "readonly", (t) => req(t.objectStore("avatars").get(url)));
}

export function hasAvatar(url) {
	if (!url) return Promise.resolve(false);
	return tx("avatars", "readonly", async (t) => !!(await req(t.objectStore("avatars").getKey(url))));
}

/* ---------- folders ---------- */

export async function listFolders() {
	const rows = await tx("folders", "readonly", (t) => req(t.objectStore("folders").getAll()));
	return rows.sort((a, b) => {
		if (a.id === DEFAULT_FOLDER_ID) return -1;
		if (b.id === DEFAULT_FOLDER_ID) return 1;
		return (a.createdAt || 0) - (b.createdAt || 0);
	});
}

function cleanFolderName(name) {
	const s = String(name ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_FOLDER_NAME);
	if (!s) throw new Error("フォルダ名を入力してください");
	return s;
}

// 同名フォルダが存在する場合は新規作成せず既存フォルダを返す。
export async function createFolder(name) {
	const clean = cleanFolderName(name);
	return tx("folders", "readwrite", async (t) => {
		const store = t.objectStore("folders");
		const all = await req(store.getAll());
		const dup = all.find((f) => f.name.toLowerCase() === clean.toLowerCase());
		if (dup) return dup;
		const folder = {
			id: `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			name: clean,
			createdAt: Date.now(),
		};
		store.put(folder);
		return folder;
	});
}

export async function renameFolder(id, name) {
	const clean = cleanFolderName(name);
	return tx("folders", "readwrite", async (t) => {
		const store = t.objectStore("folders");
		const f = await req(store.get(id));
		if (!f) throw new Error("フォルダが見つかりません");
		f.name = clean;
		store.put(f);
		return f;
	});
}

// フォルダ内のツイートは削除せず DEFAULT_FOLDER_ID へ移動する。
export function deleteFolder(id) {
	if (id === DEFAULT_FOLDER_ID) return Promise.reject(new Error("既定のフォルダは削除できません"));
	return tx(["folders", "tweets"], "readwrite", async (t) => {
		const tweets = t.objectStore("tweets");
		const rows = await req(tweets.index("folderId").getAll(id));
		const now = Date.now();
		for (const r of rows) {
			r.folderId = DEFAULT_FOLDER_ID;
			r.updatedAt = now;
			tweets.put(r);
		}
		t.objectStore("folders").delete(id);
		return rows.length;
	});
}

/* ---------- tags ---------- */

export function listTags() {
	return tx(
		"tweets",
		"readonly",
		(t) =>
			new Promise((resolve, reject) => {
				const counts = new Map();
				const cursorReq = t.objectStore("tweets").index("tags").openKeyCursor();
				cursorReq.onsuccess = () => {
					const c = cursorReq.result;
					if (!c) {
						resolve(
							[...counts]
								.map(([tag, count]) => ({ tag, count }))
								.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
						);
						return;
					}
					counts.set(c.key, (counts.get(c.key) || 0) + 1);
					c.continue();
				};
				cursorReq.onerror = () => reject(cursorReq.error);
			}),
	);
}

/* ---------- bulk (export / import) ---------- */

export function getAll(storeName) {
	return tx(storeName, "readonly", (t) => req(t.objectStore(storeName).getAll()));
}

export function bulkPut(storeName, items) {
	return tx(storeName, "readwrite", (t) => {
		const store = t.objectStore(storeName);
		for (const it of items) store.put(it);
	});
}
