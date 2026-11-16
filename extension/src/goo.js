/*
 * 保存ボタンから登録フォルダを液体の泡として広げる Goo メニュー (ISOLATED world の content script)。
 * designbookmark.com の Goo Menu を移植したもの。ばねの硬さ・減衰は元の tokens.css と同じ値を使う。
 * 泡はばねで飛び出し、フォルダを選ぶと泡が戻って中央のボタンも縮んで消える。保存結果は保存ボタン自体の表示で示す。
 * 元の goo フィルタ (ぼかしで泡同士を融合させる) は使わず、輪郭はくっきりのままにする。
 * content.js から TVaultGoo.open / close / isOpenFor / hoverAt / releaseAt を呼ぶ。描画は Shadow DOM 内で行う。
 */
(() => {
	if (globalThis.TVaultGoo) return;

	/* ---------- motion: ばねは [stiffness, damping] ---------- */
	const SPRING = {
		out: [230, 15], // --goo-out: 泡が飛び出す
		in: [520, 34], // --goo-in: 泡が戻る
		release: [300, 12], // --goo-release: ドラッグを離して元の位置へ
		pop: [520, 16], // 中央ボタンの拡大縮小
		width: [300, 20], // 中央ボタンの幅
		rot: [320, 20], // + が × に回る
		follow: [900, 50], // --spring-follow: ドラッグ中の泡
		bubOpen: [300, 14],
		bubClose: [420, 30],
		bubHover: [500, 18],
		bubInit: [420, 22],
	};
	const STAGGER = 0.045; // --goo-stagger: 45ms

	/* ---------- 寸法 (px) ---------- */
	const MS = 36; // 中央ボタン (保存ボタン 34px をわずかに覆う大きさ)
	const BH = 38; // 泡の高さ
	const GAP0 = 22; // 中央ボタンと最初の泡の間隔
	const GAP = 18; // 泡同士の間隔
	const COL_GAP = 26; // 列同士の間隔。列の区切りが分かるよう GAP より広くとる
	const MAX_PER_COL = 8; // 1 列に並べる泡の上限。超えた分はさらに外側の列へ
	const EDGE = 8;
	const PAD = 24; // 拡大・伸縮した泡が描画範囲からはみ出さないよう足す余白

	const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const S = (x, k = 400, c = 30) => ({ x, v: 0, t: x, k, c });
	const tune = (s, k, c) => {
		s.k = k;
		s.c = reduce ? 2 * Math.sqrt(k) : c;
	};
	const step = (s, dt) => {
		const a = -s.k * (s.x - s.t) - s.c * s.v;
		s.v += a * dt;
		s.x += s.v * dt;
	};
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

	const svg = (p, sw = 1.9) =>
		`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
	const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>', 2.2);

	const CSS = `
    :host { all: initial; }
    .root {
      position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483645; pointer-events: none;
      font: 700 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
      --accent: #1d9bf0; --on-accent: #fff;
      --radius: 8px; /* ポップオーバーのフォルダ行・入力欄と同じ角丸 */
      -webkit-font-smoothing: antialiased; user-select: none;
    }
    .root[hidden] { display: none; }
    .layer, .ui { position: absolute; }
    .blob { position: absolute; left: 0; top: 0; border-radius: var(--radius); background: var(--accent); will-change: transform; }
    .gbtn {
      all: unset; position: absolute; left: 0; top: 0; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      border-radius: var(--radius); color: var(--on-accent); cursor: pointer; pointer-events: auto; touch-action: none;
      white-space: nowrap; will-change: transform;
    }
    .gbtn:focus-visible { box-shadow: inset 0 0 0 2px var(--on-accent); }
    .bub { height: ${BH}px; padding: 0 16px; width: max-content; max-width: 200px; }
    .bub .nm { overflow: hidden; text-overflow: ellipsis; }
    .bub.last::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
    .main { height: ${MS}px; overflow: hidden; }
    .plus { position: absolute; left: 50%; top: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; display: grid; place-items: center; }
    .plus svg { width: 100%; height: 100%; display: block; }
  `;

	let host = null;
	let shadow = null;
	let rootEl = null;
	let layerEl = null;
	let uiEl = null;
	let mainBlob = null;
	let mainBtn = null;

	let cur = null; // { anchor, dir, perCol, onPick, picked }
	let bubs = [];
	let open = false;
	let box = { l: 0, t: 0, w: 0, h: 0 };
	const main = { sc: S(0, ...SPRING.pop), w: S(MS, ...SPRING.width), rot: S(0, ...SPRING.rot), ox: S(0) };

	/* ---------- ループとタイマー ---------- */
	// 表示中のみ rAF を回し、全てが止まったら非表示にしてループを止める。

	const timers = [];
	const after = (sec, fn) => {
		const t = { t: sec, fn };
		timers.push(t);
		kick();
		return t;
	};

	let raf = 0;
	let last = 0;
	function kick() {
		if (raf) return;
		last = performance.now();
		raf = requestAnimationFrame(loop);
	}

	function loop(now) {
		raf = 0;
		const dt = Math.min((now - last) / 1000, 1 / 30);
		last = now;
		for (let i = timers.length - 1; i >= 0; i--) {
			const t = timers[i];
			if (!t) continue;
			t.t -= dt;
			if (t.t <= 0) {
				timers.splice(timers.indexOf(t), 1);
				t.fn();
			}
		}
		if (!cur) return;
		const sub = 4;
		for (let k = 0; k < sub; k++) frame(dt / sub);
		render();
		if (!cur) return;
		if (idle()) hardHide();
		else raf = requestAnimationFrame(loop);
	}

	// 中央ボタンが縮みきり、泡も全て中央へ戻ったら止める。
	function idle() {
		return (
			!open &&
			!timers.length &&
			main.sc.t === 0 &&
			main.sc.x < 0.02 &&
			Math.abs(main.sc.v) < 0.05 &&
			bubs.every((b) => !b.pending && Math.hypot(b.x.x, b.y.x) < 1)
		);
	}

	function frame(dt) {
		for (const b of bubs) {
			if (b.pending) b.pending.t -= dt;
			if (b.pending && b.pending.t <= 0) {
				const p = b.pending;
				b.pending = null;
				tune(b.x, p.k, p.c);
				tune(b.y, p.k, p.c);
				b.x.t = p.pos.x;
				b.y.t = p.pos.y;
			}
			step(b.x, dt);
			step(b.y, dt);
			step(b.s, dt);
		}
		step(main.sc, dt);
		step(main.w, dt);
		step(main.rot, dt);
		step(main.ox, dt);
	}

	function render() {
		const a = cur.anchor;
		if (!a.isConnected) {
			hardHide();
			return;
		}
		const r = a.getBoundingClientRect();
		rootEl.style.transform = `translate(${r.left + r.width / 2}px,${r.top + r.height / 2}px)`;

		const w = main.w.x;
		const s = Math.max(0, main.sc.x);
		const mt = `translate(${main.ox.x - w / 2 - box.l}px,${-MS / 2 - box.t}px) scale(${s})`;
		mainBlob.style.width = `${w}px`;
		mainBlob.style.transform = mt;
		mainBtn.style.width = `${w}px`;
		mainBtn.style.transform = mt;
		mainBtn.firstElementChild.style.transform = `rotate(${main.rot.x}deg)`;

		for (const b of bubs) {
			const x = b.x.x - b.w / 2 - box.l;
			const y = b.y.x - BH / 2 - box.t;
			const sc = Math.max(0, b.s.x);
			// 移動方向に伸び縮みさせる。泡は横長のピルなので回転させず、縦横の成分で配分する。
			const sp = Math.hypot(b.x.v, b.y.v);
			const st = 1 + Math.min(sp / 2600, 0.32);
			// 方向の成分は 2 乗して配分する (ux + uy = 1)。そのままでは斜め移動で √2 倍に膨らむ。
			const ux = sp ? (b.x.v / sp) ** 2 : 0;
			const uy = 1 - ux;
			const sx = sc * (ux * st + uy / st);
			const sy = sc * (uy * st + ux / st);
			b.blob.style.transform = `translate(${x}px,${y}px) scale(${sx},${sy})`;
			b.btn.style.transform = `translate(${x}px,${y}px) scale(${sc})`;
			b.btn.style.opacity = String(clamp((Math.hypot(b.x.x, b.y.x) - 18) / 40, 0, 1));
			b.btn.style.pointerEvents = open ? "auto" : "none";
		}
	}

	/* ---------- DOM ---------- */

	function ensure() {
		if (host?.isConnected) return;
		host = document.createElement("div");
		host.id = "tvault-goo-host";
		shadow = host.attachShadow({ mode: "open" });
		shadow.innerHTML = `<style>${CSS}</style>
      <div class="root" hidden><div class="layer"></div><div class="ui"></div></div>`;
		rootEl = shadow.querySelector(".root");
		layerEl = shadow.querySelector(".layer");
		uiEl = shadow.querySelector(".ui");

		mainBlob = document.createElement("div");
		mainBlob.className = "blob";
		mainBlob.style.height = `${MS}px`;
		mainBtn = document.createElement("button");
		mainBtn.type = "button";
		mainBtn.className = "gbtn main";
		mainBtn.innerHTML = `<span class="plus">${ICON_PLUS}</span>`;
		layerEl.appendChild(mainBlob);
		uiEl.appendChild(mainBtn);

		mainBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (cur && open) close(e.detail === 0);
		});

		// シャドウ DOM 内のキー操作がページのキーボードショートカットとして処理されないよう伝播を止める。
		for (const type of ["keydown", "keyup", "keypress"]) {
			host.addEventListener(type, (e) => {
				e.stopPropagation();
				if (type === "keydown") onKey(e);
			});
		}
		(document.body || document.documentElement).appendChild(host);
	}

	function onKey(e) {
		if (!cur) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close(true);
			return;
		}
		// 上下キーは並び順、左右キーは隣の列 (ボタンから離れる向きが次の列) へ移動する。
		const across = cur.perCol * cur.dir;
		const delta = { ArrowLeft: -across, ArrowRight: across, ArrowDown: 1, ArrowUp: -1 }[e.key];
		if (!open || !delta) return;
		e.preventDefault();
		const i = bubs.findIndex((b) => b.btn === shadow.activeElement);
		if (i < 0) {
			bubs[0]?.btn.focus();
			return;
		}
		// 上下は端で止め、左右は隣の列がある場合のみ移動する。
		const sideways = e.key === "ArrowLeft" || e.key === "ArrowRight";
		const to = i + delta;
		if (sideways && (to < 0 || to >= bubs.length)) return;
		bubs[clamp(to, 0, bubs.length - 1)]?.btn.focus();
	}

	function build(folders, currentId, verb) {
		for (const b of bubs) {
			b.blob.remove();
			b.btn.remove();
		}
		bubs = folders.map((folder) => {
			const blob = document.createElement("div");
			blob.className = "blob";
			blob.style.height = `${BH}px`;
			layerEl.insertBefore(blob, mainBlob);
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = folder.id === currentId ? "gbtn bub last" : "gbtn bub";
			btn.tabIndex = -1;
			btn.title = folder.name;
			btn.setAttribute("aria-label", `「${folder.name}」${verb}`);
			const nm = document.createElement("span");
			nm.className = "nm";
			nm.textContent = folder.name;
			btn.appendChild(nm);
			uiEl.insertBefore(btn, mainBtn);
			const b = {
				folder,
				blob,
				btn,
				w: 0,
				s0: 0.5,
				x: S(0),
				y: S(0),
				s: S(0.5, ...SPRING.bubInit),
				pending: null,
			};
			bindBubble(b);
			return b;
		});
		// 幅は文字に合わせて測り、泡の形 (blob) を同じ幅にする。
		for (const b of bubs) {
			// offsetWidth は端数を切り捨てることがあり、1px 足りないだけで名前が大きく省略されるため、実寸を切り上げて余裕を足す。
			b.w = Math.max(BH, Math.ceil(b.btn.getBoundingClientRect().width) + 1);
			b.btn.style.width = b.blob.style.width = `${b.w}px`;
			// 出発前の泡が中央ボタンからはみ出さない大きさから始める。
			b.s0 = Math.min(0.5, (MS * 0.8) / b.w);
			b.s.x = b.s.t = b.s0;
		}
	}

	/*
	 * 泡の配置。フォルダ名は横に長いため、保存ボタンの横へ出して縦一列に並べる。
	 * 列はボタンの高さを中心に上下へ広げ (画面からはみ出す分はずらす)、ボタン側の端をそろえる。
	 * 右に出す。右に入りきらず左のほうが広い場合のみ左に出す。縦に入りきらない分はさらに外側の列へ回す。
	 */
	function layout() {
		const r = cur.anchor.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height / 2;
		const start = MS / 2 + GAP0;
		const stepY = BH + GAP;

		const fit = Math.max(1, Math.floor((innerHeight - EDGE * 2 + GAP) / stepY));
		const nCols = Math.ceil(bubs.length / Math.min(fit, MAX_PER_COL));
		const perCol = Math.ceil(bubs.length / nCols);
		const cols = [];
		bubs.forEach((b, i) => {
			const c = Math.floor(i / perCol);
			if (!cols[c]) cols[c] = [];
			cols[c].push(b);
		});
		const widths = cols.map((col) => Math.max(...col.map((b) => b.w)));
		const need = start + widths.reduce((sum, w) => sum + w + COL_GAP, -COL_GAP);
		const left = cx - EDGE;
		const right = innerWidth - EDGE - cx;
		const dir = right >= need || right >= left ? 1 : -1;
		cur.dir = dir;
		cur.perCol = perCol;

		let inner = start;
		cols.forEach((col, c) => {
			const h = col.length * stepY - GAP;
			const top = clamp(-h / 2, EDGE - cy, innerHeight - EDGE - cy - h);
			col.forEach((b, j) => {
				const i = c * perCol + j;
				b.j = i;
				b.home = { x: dir * (inner + b.w / 2), y: top + BH / 2 + j * stepY };
				// 元の Goo Menu と同じく、並び順に 45ms ずつずらして出す。
				b.delayOut = i * STAGGER;
			});
			inner += widths[c] + COL_GAP;
		});
		updateBox();
	}

	function updateBox() {
		let l = -MS;
		let r = MS;
		let t = -MS;
		let btm = MS;
		for (const b of bubs) {
			const hw = (b.w / 2) * 1.35;
			const hh = (BH / 2) * 1.35;
			l = Math.min(l, b.home.x - hw);
			r = Math.max(r, b.home.x + hw);
			t = Math.min(t, b.home.y - hh);
			btm = Math.max(btm, b.home.y + hh);
		}
		const half = Math.max(main.w.t, MS) * 0.6;
		l = Math.min(l, main.ox.t - half);
		r = Math.max(r, main.ox.t + half);
		box = { l: l - PAD, t: t - PAD, w: r - l + PAD * 2, h: btm - t + PAD * 2 };
		for (const el of [layerEl, uiEl]) {
			el.style.left = `${box.l}px`;
			el.style.top = `${box.t}px`;
			el.style.width = `${box.w}px`;
			el.style.height = `${box.h}px`;
		}
	}

	/* ---------- 泡: ホバー、ゴムのようなドラッグ、クリックで保存 ---------- */

	const band = (r, d = 70) => d * (1 - 1 / ((r * 0.55) / d + 1));

	function bindBubble(b) {
		const btn = b.btn;
		btn.addEventListener("pointerenter", () => {
			if (!open || b.drag) return;
			b.s.t = 1.14;
			tune(b.s, ...SPRING.bubHover);
		});
		btn.addEventListener("pointerleave", () => {
			if (open && !b.drag) b.s.t = 1;
		});
		btn.addEventListener("pointerdown", (e) => {
			if (!open || e.button !== 0) return;
			e.stopPropagation();
			b.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, live: false };
			try {
				btn.setPointerCapture(e.pointerId);
			} catch {
				/* キャプチャできなくてもクリックは処理する */
			}
			b.s.t = 0.92;
		});
		btn.addEventListener("pointermove", (e) => {
			const d = b.drag;
			if (!d || d.id !== e.pointerId) return;
			const dx = e.clientX - d.x0;
			const dy = e.clientY - d.y0;
			const r = Math.hypot(dx, dy);
			if (!d.live && r > 4) {
				d.live = true;
				b.s.t = 1.08;
			}
			if (!d.live) return;
			const k = band(r) / (r || 1);
			b.pending = null;
			tune(b.x, ...SPRING.follow);
			tune(b.y, ...SPRING.follow);
			b.x.t = b.home.x + dx * k;
			b.y.t = b.home.y + dy * k;
		});
		const up = (e) => {
			const d = b.drag;
			if (!d || d.id !== e.pointerId) return;
			b.drag = null;
			if (d.live) {
				// 離すと揺れながら元の位置へ戻る。
				tune(b.x, ...SPRING.release);
				tune(b.y, ...SPRING.release);
				b.x.t = b.home.x;
				b.y.t = b.home.y;
				b.s.t = 1;
			} else if (e.type === "pointerup" && open) {
				b.s.t = 1;
				b.s.v += 4;
				pick(b, 0.08);
			}
		};
		btn.addEventListener("pointerup", up);
		btn.addEventListener("pointercancel", up);
		btn.addEventListener("keydown", (e) => {
			if (!open || (e.key !== "Enter" && e.key !== " ")) return;
			e.preventDefault();
			pick(b, 0, true);
		});
		btn.addEventListener("click", (e) => e.stopPropagation());
	}

	function sendTo(b, delay, pos, k, c) {
		b.pending = { t: delay, pos, k, c };
	}

	// closeAt 秒後に泡を戻す。泡が戻るまでの間に重ねて選ばれても、最初の 1 回のみ扱う。
	// 中央ボタンは保存ボタンの開閉アニメーションを隠さないよう、選んだ時点で縮め始める。
	// refocus: キーボードで選んだ場合、消える泡からフォーカスを保存ボタンへ戻す。
	function pick(b, closeAt, refocus = false) {
		if (!cur || !open || cur.picked) return;
		const c = cur;
		c.picked = true;
		tune(main.sc, ...SPRING.in);
		main.sc.t = 0;
		after(closeAt, () => close(refocus));
		c.onPick?.(b.folder);
	}

	/* ---------- 開閉 ---------- */

	function hardHide() {
		timers.length = 0;
		open = false;
		cur = null;
		if (!rootEl) return;
		rootEl.hidden = true;
		for (const b of bubs) {
			b.blob.remove();
			b.btn.remove();
		}
		bubs = [];
	}

	/*
	 * anchor: 保存ボタン。folders: [{ id, name }]。currentId: 前回のフォルダ (点で示す)。
	 * onPick(folder): フォルダが選ばれたとき。
	 * focus: キーボードで開いた場合に最初の泡へフォーカスする。
	 */
	function openMenu(anchor, { folders, currentId, verb = "に保存", onPick, focus } = {}) {
		ensure();
		hardHide();
		cur = { anchor, dir: -1, perCol: 1, onPick, picked: false };
		rootEl.hidden = false;
		build(folders || [], currentId, verb);
		main.w.x = main.w.t = MS;
		main.w.v = 0;
		main.ox.x = main.ox.t = main.ox.v = 0;
		layout();

		open = true;
		mainBtn.setAttribute("aria-label", "フォルダの選択を閉じる");
		mainBtn.setAttribute("aria-expanded", "true");
		tune(main.sc, ...SPRING.pop);
		main.sc.x = 0.3;
		main.sc.v = 0;
		main.sc.t = 1;
		main.rot.x = main.rot.v = 0;
		main.rot.t = 135;
		for (const b of bubs) {
			b.btn.tabIndex = 0;
			sendTo(b, b.delayOut, b.home, ...SPRING.out);
			b.s.t = 1;
			tune(b.s, ...SPRING.bubOpen);
		}
		render();
		kick();
		if (focus) after(0.12, () => bubs[0]?.btn.focus());
	}

	function close(refocus) {
		if (!cur || !open) return;
		open = false;
		mainBtn.setAttribute("aria-expanded", "false");
		main.rot.t = 0;
		main.sc.v -= 1.6;
		let maxDelay = 0;
		for (const b of bubs) {
			b.btn.tabIndex = -1;
			b.drag = null;
			const delay = (bubs.length - 1 - b.j) * STAGGER * 0.66;
			maxDelay = Math.max(maxDelay, delay);
			sendTo(b, delay, { x: 0, y: 0 }, ...SPRING.in);
			b.s.t = b.s0;
			tune(b.s, ...SPRING.bubClose);
		}
		vanishAfter(maxDelay + 0.12);
		if (refocus) cur.anchor.focus({ preventScroll: true });
		kick();
	}

	// 泡が戻った後、中央ボタンも縮めて消す。
	function vanishAfter(sec) {
		after(sec, () => {
			if (!cur || open) return;
			tune(main.sc, ...SPRING.in);
			main.sc.t = 0;
		});
	}

	/*
	 * 長押しで開いたまま指 (ポインタ) を動かしたとき。押したままではポインタが保存ボタンに捕捉され、
	 * 泡に pointerenter が届かないため、座標から泡を探して膨らませる。
	 */
	let holdHover = null;
	function bubbleAt(x, y) {
		if (!cur || !open) return null;
		const el = shadow.elementFromPoint(x, y)?.closest(".bub");
		return bubs.find((b) => b.btn === el) || null;
	}

	function hoverAt(anchor, x, y) {
		if (!cur || cur.anchor !== anchor) return;
		const b = bubbleAt(x, y);
		if (b === holdHover) return;
		if (holdHover && open) holdHover.s.t = 1;
		holdHover = b;
		if (b) {
			b.s.t = 1.14;
			tune(b.s, ...SPRING.bubHover);
		}
	}

	// 長押しのまま泡の上で離すと、そのフォルダを選んだことにする。泡の外で離した場合はメニューを開いたままにする。
	function releaseAt(anchor, x, y) {
		holdHover = null;
		if (!cur || cur.anchor !== anchor) return false;
		const b = bubbleAt(x, y);
		if (!b) return false;
		b.s.t = 1;
		b.s.v += 4;
		pick(b, 0.08);
		return true;
	}

	function isOpenFor(anchor) {
		return !!cur && open && cur.anchor === anchor;
	}

	// フォーカスがページ側にあっても Escape で閉じる。X のショートカットには渡さない。
	window.addEventListener(
		"keydown",
		(e) => {
			if (!cur || !open || e.key !== "Escape" || e.composedPath().includes(host)) return;
			e.preventDefault();
			e.stopPropagation();
			close(false);
		},
		true,
	);

	// メニューの外を押すと閉じる。保存ボタン自体のクリックは content.js 側で閉じる。
	document.addEventListener(
		"pointerdown",
		(e) => {
			if (!cur || !open) return;
			const path = e.composedPath();
			if (path.includes(host) || path.includes(cur.anchor)) return;
			close(false);
		},
		true,
	);

	globalThis.TVaultGoo = {
		open: openMenu,
		close,
		isOpenFor,
		hoverAt,
		releaseAt,
	};
})();
