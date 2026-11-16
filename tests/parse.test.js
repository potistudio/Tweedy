import { test } from "node:test";
import assert from "node:assert/strict";
import "../extension/src/parse.js";

const P = globalThis.TVaultParse;

function gqlTweet({
	id,
	screenName = "alice",
	name = "Alice",
	text,
	media,
	urls = [],
	quote,
	newUserShape = true,
	note,
}) {
	const user = newUserShape
		? {
				rest_id: "1",
				core: { screen_name: screenName, name },
				avatar: { image_url: `https://pbs.twimg.com/profile_images/1/${screenName}_normal.jpg` },
				legacy: {},
			}
		: {
				rest_id: "1",
				legacy: {
					screen_name: screenName,
					name,
					profile_image_url_https: `https://pbs.twimg.com/profile_images/1/${screenName}_normal.png`,
				},
			};
	return {
		__typename: "Tweet",
		rest_id: id,
		core: { user_results: { result: user } },
		...(note ? { note_tweet: { note_tweet_results: { result: note } } } : {}),
		...(quote ? { quoted_status_result: { result: quote } } : {}),
		legacy: {
			full_text: text,
			created_at: "Wed Oct 10 20:19:24 +0000 2018",
			lang: "ja",
			entities: { urls, media: media ? media.map((m) => ({ url: m.url })) : undefined },
			extended_entities: media ? { media } : undefined,
			...(quote ? { quoted_status_id_str: quote.rest_id || quote.tweet?.rest_id } : {}),
		},
	};
}

test("GraphQL: 写真・動画・GIF・本文の展開", () => {
	const t = P.fromGraphql(
		gqlTweet({
			id: "100",
			text: "hello &amp; world https://t.co/link https://t.co/media",
			urls: [{ url: "https://t.co/link", expanded_url: "https://example.com/page" }],
			media: [
				{
					type: "photo",
					url: "https://t.co/media",
					media_url_https: "https://pbs.twimg.com/media/ABC.jpg",
					original_info: { width: 1200, height: 800 },
				},
				{
					type: "video",
					url: "https://t.co/media",
					media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg",
					video_info: {
						variants: [
							{ content_type: "application/x-mpegURL", url: "https://video.twimg.com/x.m3u8" },
							{ content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/low.mp4" },
							{ content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" },
						],
					},
				},
				{
					type: "animated_gif",
					url: "https://t.co/media",
					media_url_https: "https://pbs.twimg.com/tweet_video_thumb/g.jpg",
					video_info: {
						variants: [
							{ content_type: "video/mp4", bitrate: 0, url: "https://video.twimg.com/tweet_video/g.mp4" },
						],
					},
				},
			],
		}),
	);
	assert.equal(t.id, "100");
	assert.equal(t.text, "hello & world https://example.com/page");
	assert.equal(t.url, "https://x.com/alice/status/100");
	assert.equal(t.createdAt, "2018-10-10T20:19:24.000Z");
	assert.equal(t.author.avatarUrl, "https://pbs.twimg.com/profile_images/1/alice_bigger.jpg");
	assert.deepEqual(
		t.media.map((m) => m.type),
		["photo", "video", "gif"],
	);
	assert.equal(t.media[0].url, "https://pbs.twimg.com/media/ABC?format=jpg&name=orig");
	assert.equal(t.media[0].width, 1200);
	assert.equal(t.media[1].url, "https://video.twimg.com/high.mp4");
	assert.equal(t.media[1].posterUrl, "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg");
	assert.equal(t.media[2].url, "https://video.twimg.com/tweet_video/g.mp4");
	assert.equal(t.quote, null);
});

test("GraphQL: 旧ユーザー形式・引用ツイート・visibility ラッパー", () => {
	const quote = {
		__typename: "TweetWithVisibilityResults",
		tweet: gqlTweet({ id: "50", screenName: "bob", name: "Bob", text: "quoted" }),
	};
	const t = P.fromGraphql(
		gqlTweet({
			id: "200",
			newUserShape: false,
			text: "look https://t.co/q",
			urls: [{ url: "https://t.co/q", expanded_url: "https://twitter.com/bob/status/50" }],
			quote,
		}),
	);
	assert.equal(t.author.screenName, "alice");
	assert.equal(t.author.avatarUrl, "https://pbs.twimg.com/profile_images/1/alice_bigger.png");
	assert.equal(t.text, "look");
	assert.equal(t.quote.id, "50");
	assert.equal(t.quote.author.name, "Bob");
	assert.equal(t.quote.quote, null);
});

test("GraphQL: 長文ツイート (note_tweet) を優先する", () => {
	const t = P.fromGraphql(
		gqlTweet({
			id: "300",
			text: "truncated…",
			note: {
				text: "full long text https://t.co/a",
				entity_set: { urls: [{ url: "https://t.co/a", expanded_url: "https://a.example" }] },
			},
		}),
	);
	assert.equal(t.text, "full long text https://a.example");
});

test("collectFromGraphql: タイムライン構造からツイートを重複なく抽出する", () => {
	const a = gqlTweet({ id: "1", text: "a" });
	const b = gqlTweet({ id: "2", text: "b", quote: gqlTweet({ id: "3", text: "c" }) });
	const json = {
		data: {
			home: {
				home_timeline_urt: {
					instructions: [
						{
							entries: [
								{ content: { itemContent: { tweet_results: { result: a } } } },
								{ content: { itemContent: { tweet_results: { result: b } } } },
								{ content: { itemContent: { tweet_results: { result: a } } } },
								{
									content: {
										itemContent: {
											user_results: { result: { rest_id: "9", legacy: { screen_name: "u" } } },
										},
									},
								},
							],
						},
					],
				},
			},
		},
	};
	const ids = P.collectFromGraphql(json)
		.map((t) => t.id)
		.sort();
	assert.deepEqual(ids, ["1", "2", "3"]);
});

test("syndication: レスポンスを正規化する", () => {
	const t = P.fromSyndication({
		__typename: "Tweet",
		id_str: "400",
		text: "syn &lt;3 https://t.co/m",
		created_at: "2024-01-02T03:04:05.000Z",
		lang: "en",
		user: {
			name: "Carol",
			screen_name: "carol",
			profile_image_url_https: "https://pbs.twimg.com/profile_images/9/c_normal.jpg",
		},
		entities: { urls: [], media: [{ url: "https://t.co/m" }] },
		mediaDetails: [
			{
				type: "photo",
				url: "https://t.co/m",
				media_url_https: "https://pbs.twimg.com/media/XYZ.png",
				original_info: { width: 10, height: 20 },
			},
		],
		quoted_tweet: { id_str: "401", text: "q", user: { screen_name: "dave", name: "Dave" }, mediaDetails: [] },
	});
	assert.equal(t.text, "syn <3");
	assert.equal(t.media[0].url, "https://pbs.twimg.com/media/XYZ?format=png&name=orig");
	assert.equal(t.quote.id, "401");
	assert.equal(t.source, "syndication");
	assert.equal(P.fromSyndication({ __typename: "TweetTombstone" }), null);
});

test("photoUrl: DOM の画像 URL を原寸へ変換する", () => {
	assert.equal(
		P.photoUrl("https://pbs.twimg.com/media/ABC?format=jpg&name=small"),
		"https://pbs.twimg.com/media/ABC?format=jpg&name=orig",
	);
	assert.equal(P.photoUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
});

/* ---------- 2026 年時点の新スキーマ (実データから作成した fixture) ---------- */

import { readFileSync } from "node:fs";

const FX = JSON.parse(readFileSync(new URL("./fixtures/graphql-2026.json", import.meta.url), "utf8"));

test("新スキーマ: 写真ツイート (details / media_entities2)", () => {
	const t = P.fromGraphql(FX.photo);
	assert.equal(t.id, "1770888775830262034");
	assert.equal(t.text, "@jack", "メディアの t.co URL は indices から特定して削除する");
	assert.equal(t.createdAt, new Date(1711047760000).toISOString());
	assert.equal(t.author.screenName, "derbederdusler");
	assert.match(t.author.avatarUrl, /_bigger\.jpg$/);
	assert.equal(t.media.length, 1);
	assert.equal(t.media[0].type, "photo");
	assert.equal(t.media[0].url, "https://pbs.twimg.com/media/GJN19MHXQAAeNDq?format=jpg&name=orig");
	assert.equal(t.media[0].width, 1080);
});

test("新スキーマ: 動画は最高ビットレートの mp4 を選ぶ", () => {
	const t = P.fromGraphql(FX.video);
	assert.equal(t.text, "Some phone videos I took from the tower");
	assert.ok(t.media.length >= 1);
	assert.equal(t.media[0].type, "video");
	assert.match(t.media[0].url, /1080x1920.*\.mp4/);
	assert.match(t.media[0].posterUrl, /amplify_video_thumb/);
});

test("新スキーマ: 引用ツイート (quoted_tweet_results)", () => {
	const t = P.fromGraphql(FX.quote);
	assert.equal(t.id, "2121875758704370144");
	assert.equal(t.quote.id, "2121750619816095753");
	assert.equal(t.quote.author.screenName, "cb_doge");
	assert.equal(t.quote.media[0].type, "video");
	assert.ok(!/t\.co/.test(t.quote.text), "引用先のメディア URL も削除する");
});

test("新スキーマ: 長文ツイートは note_tweet を優先する", () => {
	const t = P.fromGraphql(FX.note);
	assert.match(t.text, /https:\/\/www\.nasa\.gov\/general\/max-power/);
	assert.ok(t.text.length > FX.note.details.full_text.length - 30);
});

test("新スキーマ: レスポンス全体から本体と引用先を抽出する", () => {
	const ids = P.collectFromGraphql(FX.timeline)
		.map((t) => t.id)
		.sort();
	assert.deepEqual(
		ids,
		["1770888775830262034", "2121750619816095753", "2121763396190179414", "2121875758704370144"].sort(),
	);
});

test("collectFromScriptText: HTML の script に文字列として埋め込まれた結果を抽出する", () => {
	const payload = JSON.stringify(JSON.stringify(FX.timeline));
	const script = `self.x=[{result:$R[1]={kind:"Result.Ok",value:${payload}}}]; var s = "\x3Cdiv>";`;
	const ids = P.collectFromScriptText(script).map((t) => t.id);
	assert.ok(ids.includes("2121875758704370144"));
	const twice = P.collectFromScriptText(`${script}${script}`).map((t) => t.id);
	assert.equal(twice.length, new Set(twice).size, "同じツイートは重複させない");
	assert.equal(P.collectFromScriptText("no data here").length, 0);
});

test("timeFromId: snowflake ID から投稿時刻を復元する", () => {
	const ms = Date.parse(P.timeFromId("1770888775830262034"));
	assert.ok(Math.abs(ms - 1711047760000) < 1000, "写真ツイートの created_at_ms と 1 秒以内で一致する");
	assert.equal(P.timeFromId("20"), "");
});

test("新スキーマ: url_entities が空でない場合は t.co を展開する", () => {
	const tw = structuredClone(FX.photo);
	tw.details.full_text += " https://t.co/zzz";
	tw.url_entities = [{ url: "https://t.co/zzz", expanded_url: "https://example.com/z" }];
	tw.legacy = { ...tw.legacy, entities: { urls: [] } };
	assert.equal(P.fromGraphql(tw).text, "@jack https://example.com/z");
});
