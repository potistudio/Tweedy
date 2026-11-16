import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as db from "../extension/src/db.js";

function record(id, extra = {}) {
	return {
		id,
		url: `https://x.com/a/status/${id}`,
		text: `tweet ${id}`,
		createdAt: "",
		lang: "",
		author: { name: "A", screenName: "a", avatarUrl: "https://pbs.twimg.com/a.jpg" },
		media: [{ key: `${id}:main:0`, type: "photo", stored: true }],
		quote: null,
		source: "graphql",
		folderId: db.DEFAULT_FOLDER_ID,
		tags: [],
		savedAt: Date.now(),
		updatedAt: Date.now(),
		...extra,
	};
}

test("既定フォルダが存在する", async () => {
	const folders = await db.listFolders();
	assert.equal(folders[0].id, db.DEFAULT_FOLDER_ID);
});

test("保存・状態取得・メディア取得・削除", async () => {
	const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
	await db.putTweetBundle(
		record("10", { folderId: "missing-folder", tags: ["#Foo", "foo", " bar  baz "] }),
		[{ key: "10:main:0", tweetId: "10", owner: "main", index: 0, type: "photo", blob, posterBlob: null }],
		[{ url: "https://pbs.twimg.com/a.jpg", blob }],
	);
	const saved = await db.getTweet("10");
	assert.equal(saved.folderId, db.DEFAULT_FOLDER_ID, "存在しないフォルダは既定フォルダへ置き換える");
	assert.deepEqual(saved.tags, ["Foo", "bar baz"]);

	const st = await db.getStatuses(["10", "11"]);
	assert.deepEqual(Object.keys(st), ["10"]);

	const media = await db.getMedia("10");
	assert.equal(media.length, 1);
	assert.equal(media[0].blob.size, 3);
	assert.equal(await db.hasAvatar("https://pbs.twimg.com/a.jpg"), true);

	await db.deleteTweet("10");
	assert.equal(await db.getTweet("10"), undefined);
	assert.equal((await db.getMedia("10")).length, 0);
});

test("フォルダ作成・重複・改名・削除時の移動", async () => {
	const f = await db.createFolder("  Art  ");
	assert.equal(f.name, "Art");
	const dup = await db.createFolder("art");
	assert.equal(dup.id, f.id);
	await assert.rejects(db.createFolder("   "));

	await db.putTweetBundle(record("20", { folderId: f.id }), [], []);
	assert.equal((await db.getTweet("20")).folderId, f.id);

	await db.renameFolder(f.id, "Illust");
	assert.equal((await db.listFolders()).find((x) => x.id === f.id).name, "Illust");

	const moved = await db.deleteFolder(f.id);
	assert.equal(moved, 1);
	assert.equal((await db.getTweet("20")).folderId, db.DEFAULT_FOLDER_ID);
	await assert.rejects(db.deleteFolder(db.DEFAULT_FOLDER_ID));
});

test("patchMedia: 欠落したメディアのみ補完し、既存 blob を維持する", async () => {
	const poster = new Blob([new Uint8Array([9])], { type: "image/jpeg" });
	const rec = record("40", {
		media: [
			{
				key: "40:main:0",
				type: "video",
				url: "https://video.twimg.com/v.mp4",
				posterUrl: "https://pbs.twimg.com/p.jpg",
				stored: false,
				posterStored: true,
			},
		],
	});
	await db.putTweetBundle(
		rec,
		[{ key: "40:main:0", tweetId: "40", owner: "main", index: 0, type: "video", blob: null, posterBlob: poster }],
		[],
	);
	const video = new Blob([new Uint8Array([1, 2])], { type: "video/mp4" });
	const r = await db.patchMedia("40", [
		{ key: "40:main:0", owner: "main", index: 0, type: "video", blob: video, posterBlob: null },
	]);
	assert.equal(r.media[0].stored, true);
	const [row] = await db.getMedia("40");
	assert.equal(row.blob.size, 2);
	assert.equal(row.posterBlob.size, 1, "再取得しなかった posterBlob は維持する");

	await db.putTweetBundle(
		record("41"),
		[{ key: "41:main:0", tweetId: "41", owner: "main", index: 0, type: "photo", blob: poster, posterBlob: null }],
		[],
	);
	await db.patchMedia("40", [
		{ key: "41:main:0", owner: "main", index: 0, type: "photo", blob: video, posterBlob: null },
		{ key: undefined, blob: video },
	]);
	const [other] = await db.getMedia("41");
	assert.equal(other.blob.size, 1, "他ツイートの key は反映しない");
});

test("更新とタグ集計", async () => {
	await db.putTweetBundle(record("30", { tags: ["x"] }), [], []);
	await db.putTweetBundle(record("31", { tags: ["x", "y"] }), [], []);
	const r = await db.updateTweet("30", { tags: ["y", "z"], folderId: "nope" });
	assert.deepEqual(r.tags, ["y", "z"]);
	assert.equal(r.folderId, db.DEFAULT_FOLDER_ID);
	const tags = await db.listTags();
	const map = Object.fromEntries(tags.map((t) => [t.tag, t.count]));
	assert.equal(map.y, 2);
	assert.equal(map.x, 1);
	assert.equal(map.z, 1);
	await assert.rejects(db.updateTweet("999", { tags: [] }));
});
